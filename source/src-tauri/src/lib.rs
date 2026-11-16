use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_fs::FsExt;
mod updates;

/// Suppress the console window Windows would otherwise allocate for a
/// console-subsystem child (engine, FFmpeg, taskkill) launched from this GUI app.
#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_cmd: &mut Command) {}

struct EngineState {
    child: Arc<Mutex<Option<Child>>>,
}

/// Prefer resource_dir (packaged), then cwd / parent (dev).
/// Tauri may nest `../resources` under `_up_/resources` next to the exe.
fn resource_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(rd) = app.path().resource_dir() {
        roots.push(rd.clone());
        roots.push(rd.join("resources"));
        roots.push(rd.join("_up_").join("resources"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.clone());
        roots.push(cwd.join("resources"));
        roots.push(cwd.join("_up_").join("resources"));
        if let Some(p) = cwd.parent() {
            roots.push(p.to_path_buf());
            roots.push(p.join("resources"));
        }
        if cwd.ends_with("src-tauri") {
            if let Some(p) = cwd.parent() {
                roots.push(p.to_path_buf());
                roots.push(p.join("resources"));
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
            roots.push(dir.join("resources"));
            // NSIS layout when bundle.resources used `../resources/...`
            roots.push(dir.join("_up_").join("resources"));
            roots.push(dir.join("_up_"));
        }
    }
    roots
}

fn find_existing(roots: &[PathBuf], rel: &str) -> Option<PathBuf> {
    for r in roots {
        let p = r.join(rel);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

#[cfg(windows)]
const ENGINE_EXE: &str = "chord-engine.exe";
#[cfg(not(windows))]
const ENGINE_EXE: &str = "chord-engine";

#[cfg(windows)]
const VENV_PYTHON: &str = "Scripts/python.exe";
#[cfg(not(windows))]
const VENV_PYTHON: &str = "bin/python";

fn resolve_python(roots: &[PathBuf]) -> PathBuf {
    for rel in [
        format!("chord-engine/{ENGINE_EXE}"),
        format!("resources/chord-engine/{ENGINE_EXE}"),
        format!("chord-engine-portable/{ENGINE_EXE}"),
        format!("resources/chord-engine-portable/{ENGINE_EXE}"),
        format!("engine/.venv/{VENV_PYTHON}"),
    ] {
        if let Some(path) = roots.iter().map(|root| root.join(&rel)).find(|path| path.is_file()) {
            return path;
        }
    }
    PathBuf::from(if cfg!(windows) { "py" } else { "python3.12" })
}

fn resolve_engine_script(roots: &[PathBuf]) -> Option<PathBuf> {
    find_existing(roots, "engine/run_engine.py")
}

fn resolve_ffmpeg_dir(roots: &[PathBuf]) -> Option<PathBuf> {
    if let Ok(d) = std::env::var("CHORD_FFMPEG_DIR") {
        let p = PathBuf::from(d);
        if p.is_dir() {
            return Some(p);
        }
    }
    let suffix = std::env::consts::EXE_SUFFIX;
    let ffmpeg = format!("ffmpeg{suffix}");
    let ffprobe = format!("ffprobe{suffix}");
    for root in roots {
        for rel in ["ffmpeg", "resources/ffmpeg", ""] {
            let dir = root.join(rel);
            if dir.join(&ffmpeg).is_file() && dir.join(&ffprobe).is_file() {
                return Some(dir);
            }
        }
    }
    // Finder launches do not normally inherit a shell's Homebrew PATH.
    #[cfg(target_os = "macos")]
    for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
        let dir = PathBuf::from(dir);
        if dir.join(&ffmpeg).is_file() && dir.join(&ffprobe).is_file() {
            return Some(dir);
        }
    }
    None
}

fn resolve_node_path(roots: &[PathBuf]) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("CHORD_NODE_PATH").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(path);
    }
    let node = format!("node{}", std::env::consts::EXE_SUFFIX);
    for root in roots {
        for dir in ["node", "resources/node", "node-portable", "resources/node-portable"] {
            let path = root.join(dir).join(&node);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

fn configure_engine_process(cmd: &mut Command) {
    hide_console(cmd);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0).env("HEARTHKEYS_ENGINE_GROUP", "1");
    }
}

fn app_cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cache dir: {e}"))?;
    let yt = dir.join("youtube");
    std::fs::create_dir_all(&yt).map_err(|e| format!("mkdir cache: {e}"))?;
    Ok(yt)
}

fn new_job_cache(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app_cache_root(app)?;
    let job = root.join(format!(
        "job_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&job).map_err(|e| format!("mkdir job: {e}"))?;
    Ok(job)
}

/// Kill process and entire tree (Windows: taskkill /F /T).
fn kill_process_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_console(&mut cmd);
        let _ = cmd.status();
    }
    #[cfg(not(windows))]
    {
        // The engine owns a process group. Signal that group, never the app's.
        if let Ok(pid) = i32::try_from(pid) {
            unsafe { libc::kill(-pid, libc::SIGTERM) };
        }
    }
}

fn kill_child(child: &Mutex<Option<Child>>) {
    if let Ok(mut guard) = child.lock() {
        if let Some(mut child) = guard.take() {
            let pid = child.id();
            kill_process_tree(pid);
            #[cfg(unix)]
            for _ in 0..25 {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                thread::sleep(std::time::Duration::from_millis(20));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn apply_engine_env(cmd: &mut Command, app: &AppHandle, roots: &[PathBuf]) {
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("PYTHONUTF8", "1");
    if let Some(ff) = resolve_ffmpeg_dir(roots) {
        cmd.env("CHORD_FFMPEG_DIR", &ff);
    }
    if let Some(node) = resolve_node_path(roots) {
        cmd.env("CHORD_NODE_PATH", &node);
        if let Some(dir) = node.parent() {
            cmd.env("CHORD_NODE_DIR", dir);
        }
    }
    if let Ok(rd) = app.path().resource_dir() {
        cmd.env("TAURI_RESOURCE_DIR", &rd);
    }

}

fn is_bundled_engine(python: &Path) -> bool {
    python
        .file_name()
        .map(|n| n.to_string_lossy().eq_ignore_ascii_case(ENGINE_EXE))
        .unwrap_or(false)
}

fn build_engine_cmd(
    app: &AppHandle,
    subcommand: &str,
    extra_args: &[&str],
) -> Result<(Command, PathBuf), String> {
    let roots = resource_roots(app);
    let python = resolve_python(&roots);
    let script = resolve_engine_script(&roots);

    let mut cmd = Command::new(&python);
    if is_bundled_engine(&python) {
        cmd.arg(subcommand);
        for a in extra_args {
            cmd.arg(a);
        }
        if let Some(parent) = python.parent() {
            cmd.current_dir(parent);
        }
    } else if let Some(script) = script {
        if python.file_name().map(|n| n == "py").unwrap_or(false) {
            cmd.arg("-3.12");
        }
        cmd.arg(&script).arg(subcommand);
        for a in extra_args {
            cmd.arg(a);
        }
    } else {
        return Err(format!(
            "Analysis engine files are missing. Reinstall Sion Keys or keep the executable with its bundled resources. Searched: {:?}",
            roots
        ));
    }

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    apply_engine_env(&mut cmd, app, &roots);
    if is_bundled_engine(&python) {
        if let Some(parent) = python.parent() {
            cmd.current_dir(parent);
        }
    }
    configure_engine_process(&mut cmd);
    Ok((cmd, python))
}

async fn run_engine_streaming(
    app: AppHandle,
    state: State<'_, EngineState>,
    cmd: Command,
    python: PathBuf,
) -> Result<Value, String> {
    let app_for_thread = app.clone();
    let child = Arc::clone(&state.child);
    tauri::async_runtime::spawn_blocking(move || run_engine_blocking(&app_for_thread, &child, cmd, &python))
        .await
        .map_err(|e| format!("Engine task failed: {e}"))?
}

struct AnalysisScratch(PathBuf);

impl Drop for AnalysisScratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn run_engine_blocking(
    app: &AppHandle,
    slot: &Mutex<Option<Child>>,
    mut cmd: Command,
    python: &Path,
) -> Result<Value, String> {
    let _scratch = if std::env::var_os("CHORD_SEPARATOR_PYTHON").is_some()
        && cmd.get_args().any(|arg| arg == "analyze" || arg == "youtube-analyze")
    {
        let scratch = (|| {
            let base = app.path().app_cache_dir().ok()?.join("analysis-scratch");
            std::fs::create_dir_all(&base).ok()?;
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
            let path = base.join(format!("{}-{stamp}", std::process::id()));
            std::fs::create_dir(&path).ok()?;
            Some(AnalysisScratch(path))
        })();
        if let Some(scratch) = &scratch {
            cmd.env("CHORD_ANALYSIS_SCRATCH", &scratch.0);
        } else {
            cmd.env_remove("CHORD_SEPARATOR_PYTHON");
        }
        scratch
    } else {
        None
    };
    let mut spawned = cmd
        .spawn()
        .map_err(|e| format!("Failed to start engine ({python:?}): {e}"))?;
    let child_id = spawned.id();

    let stdout = spawned
        .stdout
        .take()
        .ok_or_else(|| "No stdout from engine".to_string())?;
    let mut stderr = spawned
        .stderr
        .take()
        .ok_or_else(|| "No stderr from engine".to_string())?;

    // Drain stderr while stdout is read. Leaving this pipe unread can fill it
    // and deadlock the child before it emits a result.
    let stderr_task = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).trim().to_string()
    });

    // Store the child, then drop the mutex before reading stdout. Cancel
    // must be able to take this lock while the engine is still running.
    {
        let mut guard = slot.lock().map_err(|e| e.to_string())?;
        *guard = Some(spawned);
    }

    let reader = BufReader::new(stdout);
    let mut final_result: Option<Value> = None;
    let mut last_error: Option<String> = None;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                last_error = Some(e.to_string());
                break;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let _ = app.emit("engine-event", &parsed);
        if let Some(t) = parsed.get("type").and_then(|x| x.as_str()) {
            match t {
                "result" => {
                    final_result = Some(parsed);
                }
                "error" => {
                    last_error = parsed
                        .get("error")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string())
                        .or_else(|| Some("Engine error".into()));
                }
                _ => {}
            }
        }
    }

    let leftover = slot.lock().ok().and_then(|mut guard| {
        if guard.as_ref().is_some_and(|child| child.id() == child_id) {
            guard.take()
        } else {
            None
        }
    });
    let status = if let Some(mut c) = leftover {
        c.wait().ok()
    } else {
        None
    };
    let stderr_text = stderr_task.join().unwrap_or_default();

    if let Some(r) = final_result {
        return Ok(r);
    }
    if let Some(message) = last_error {
        return Err(message);
    }

    let mut detail = match status {
        Some(code) if code.success() => "Engine produced no result (exit 0)".to_string(),
        Some(code) => format!(
            "Engine produced no result (exit {})",
            code.code().unwrap_or(-1)
        ),
        None => "Engine produced no result (no exit status)".to_string(),
    };
    if !stderr_text.is_empty() {
        let tail: String = stderr_text.chars().rev().take(1200).collect::<String>().chars().rev().collect();
        detail.push_str(": ");
        detail.push_str(tail.trim());
    }
    Err(detail)
}

#[tauri::command]
fn cancel_analysis(state: State<'_, EngineState>) -> Result<(), String> {
    kill_child(&state.child);
    Ok(())
}

#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("read failed: {e}"))
}

/// Frontend overwrite prompt. Plugin-fs `exists` is scoped to app folders and
/// would miss a user-chosen save path; this command only reports existence.
#[tauri::command]
fn path_exists(path: String) -> Result<bool, String> {
    if path.trim().is_empty() {
        return Ok(false);
    }
    Ok(Path::new(&path).exists())
}

fn export_path_error(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, message)
}

fn is_export_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Includes junctions and other reparse points, not just file symlinks.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn check_export_destination(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if is_export_link(&metadata) || !metadata.is_file() => {
            Err(export_path_error("Export destination must be a regular file, not a link"))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn resolve_text_export_path(path: &Path) -> std::io::Result<PathBuf> {
    if !path.is_absolute() || path.components().any(|c| c == std::path::Component::ParentDir) {
        return Err(export_path_error("Export path must be absolute without parent traversal"));
    }
    let name = path.file_name().and_then(|n| n.to_str())
        .ok_or_else(|| export_path_error("Export filename is missing"))?;
    if name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || name.ends_with(['.', ' '])
        || !path.extension().and_then(|e| e.to_str())
            .is_some_and(|e| ["csv", "json", "html"].iter().any(|allowed| e.eq_ignore_ascii_case(allowed)))
    {
        return Err(export_path_error("Export must use a CSV, JSON, or HTML filename"));
    }
    check_export_destination(path)?;
    let parent = path.parent().ok_or_else(|| export_path_error("Export folder is missing"))?;
    // Reject linked ancestors rather than allowing lexical scope checks to hide
    // denied aliases. Canonicalize even for a new file, as plugin-fs does.
    for ancestor in parent.ancestors() {
        if is_export_link(&std::fs::symlink_metadata(ancestor)?) {
            return Err(export_path_error("Export folder must not contain symbolic links or reparse points"));
        }
    }
    Ok(parent.canonicalize()?.join(name))
}

fn atomic_text_export(path: &Path, text: &str) -> std::io::Result<()> {
    atomic_export_with(path, |file| file.write_all(text.as_bytes()))
}

fn atomic_export_with(
    path: &Path,
    write: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>,
) -> std::io::Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
    check_export_destination(path)?;
    let parent = path.parent().ok_or_else(|| export_path_error("Export folder is missing"))?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default().as_nanos();
    let mut temporary = None;
    for _ in 0..16 {
        let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let temp = parent.join(format!(".chord-export-{}-{stamp}-{id}.tmp", std::process::id()));
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&temp) {
            Ok(file) => { temporary = Some((temp, file)); break; }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    let (temp, mut file) = temporary.ok_or_else(|| std::io::Error::new(
        std::io::ErrorKind::AlreadyExists, "Could not create a unique export temporary file",
    ))?;
    let written = write(&mut file).and_then(|_| file.sync_all());
    drop(file); // Windows must release the handle before rename or cleanup.
    let result = written.and_then(|_| {
        check_export_destination(path)?;
        // Same-directory rename replaces atomically, including on Windows.
        // Never truncate or delete the existing destination first.
        std::fs::rename(&temp, path)
    });
    if result.is_err() {
        if let Err(cleanup) = std::fs::remove_file(&temp) {
            return Err(std::io::Error::other(format!(
                "{}; export temporary-file cleanup failed: {cleanup}", result.unwrap_err(),
            )));
        }
    }
    result
}

#[tauri::command]
async fn write_text_export(app: AppHandle, path: String, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let requested = Path::new(&path);
        let resolved = resolve_text_export_path(requested).map_err(|e| e.to_string())?;
        let scope = app.fs_scope();
        // Save dialogs grant the chosen file. No global write capability is needed.
        if !scope.is_allowed(requested) || !scope.is_allowed(&resolved) {
            return Err("Export path is not allowed by the filesystem scope".into());
        }
        atomic_text_export(&resolved, &text).map_err(|e| format!("Text export failed: {e}"))
    }).await.map_err(|e| format!("Text export task failed: {e}"))?
}

#[tauri::command]
async fn analyze_file(
    app: AppHandle,
    state: State<'_, EngineState>,
    path: String,
    name: Option<String>,
) -> Result<Value, String> {
    kill_child(&state.child);
    let mut args = vec![path.as_str()];
    if let Some(name) = name.as_deref() {
        args.extend(["--name", name]);
    }
    let (cmd, python) = build_engine_cmd(&app, "analyze", &args)?;
    run_engine_streaming(app, state, cmd, python).await
}

#[tauri::command]
async fn analyze_youtube(
    app: AppHandle,
    state: State<'_, EngineState>,
    url: String,
    audio_only: Option<bool>,
) -> Result<Value, String> {
    kill_child(&state.child);
    let cache = new_job_cache(&app)?;
    let cache_s = cache.to_string_lossy().to_string();
    let mut args = vec![url.as_str(), "--cache-dir", cache_s.as_str()];
    if audio_only.unwrap_or(false) { args.push("--audio-only"); }
    let (cmd, python) = build_engine_cmd(
        &app,
        "youtube-analyze",
        &args,
    )?;
    let result = run_engine_streaming(app, state, cmd, python).await;
    // On failure, clean job cache immediately
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&cache);
    }
    result
}

#[derive(Default)]
struct AlignmentJob {
    cancelled: std::sync::atomic::AtomicBool,
    pid: std::sync::atomic::AtomicU32,
}

#[derive(Default)]
struct AlignmentState {
    current: Mutex<Option<(String, Arc<AlignmentJob>)>>,
}

#[tauri::command]
fn cancel_lyrics_alignment(job: String, state: State<'_, AlignmentState>) {
    if let Ok(current) = state.current.lock() {
        if let Some((_, running)) = current.as_ref().filter(|(id, _)| id == &job) {
            running.cancelled.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }
}

#[tauri::command]
async fn align_lyrics(app: AppHandle, job: String, request: Value, state: State<'_, AlignmentState>) -> Result<Value, String> {
    use std::sync::atomic::Ordering;
    let root = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("alignment");
    let python = root.join("runtime").join(VENV_PYTHON);
    if !python.is_file() {
        return Ok(serde_json::json!({"state": "unavailable"}));
    }
    let generating = request.get("transcribe").and_then(Value::as_bool) == Some(true);
    let timeout = if generating { 1200 } else { 300 };
    let payload = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    if payload.len() > 262144 || job.len() > 80 { return Err("Alignment request too large".into()); }
    let running = Arc::new(AlignmentJob::default());
    {
        let mut current = state.current.lock().map_err(|_| "Alignment state unavailable")?;
        if let Some((_, previous)) = current.replace((job.clone(), Arc::clone(&running))) {
            previous.cancelled.store(true, Ordering::Relaxed);
        }
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(python);
        // Stream the bundled worker through stdin to stay under Windows' command-line limit.
        let source = include_bytes!("../../engine/lyrics_alignment.py");
        let morphology = include_bytes!("../../engine/data/bulgarian-morphology.tsv.gz");
        let bootstrap = "import sys; stream=sys.stdin.buffer; source=stream.read(int(stream.readline())); _bulgarian_morphology_gzip=stream.read(int(stream.readline())); exec(compile(source, '<lyrics_alignment>', 'exec'))";
        cmd.arg("-I").arg("-c").arg(bootstrap)
            .arg(root.join("model")).arg(root.join("timings"))
            .env("HF_HUB_OFFLINE", "1").env("HF_HUB_DISABLE_TELEMETRY", "1")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        configure_engine_process(&mut cmd);
        if running.cancelled.load(Ordering::Relaxed) { return Err("Alignment cancelled".into()); }
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        running.pid.store(child.id(), Ordering::Relaxed);
        let mut input = child.stdin.take().ok_or("Alignment input unavailable")?;
        let writer = thread::spawn(move || {
            writeln!(input, "{}", source.len())?;
            input.write_all(source)?;
            writeln!(input, "{}", morphology.len())?;
            input.write_all(morphology)?;
            input.write_all(&payload)
        });
        let stdout = child.stdout.take().ok_or("Alignment output unavailable")?;
        let reader = thread::spawn(move || { let mut data = Vec::new(); stdout.take(4 * 1024 * 1024 + 1).read_to_end(&mut data).map(|_| data) });
        let start = std::time::Instant::now();
        loop {
            if running.cancelled.load(Ordering::Relaxed) || start.elapsed().as_secs() >= timeout {
                kill_process_tree(child.id());
                let _ = child.wait();
                running.pid.store(0, Ordering::Relaxed);
                return Err("Alignment cancelled or timed out".into());
            }
            if child.try_wait().map_err(|e| e.to_string())?.is_some() { break; }
            thread::sleep(std::time::Duration::from_millis(50));
        }
        running.pid.store(0, Ordering::Relaxed);
        writer.join().map_err(|_| "Alignment input failed")?.map_err(|e| e.to_string())?;
        let bytes = reader.join().map_err(|_| "Alignment output failed")?.map_err(|e| e.to_string())?;
        if bytes.len() > 4 * 1024 * 1024 { return Err("Lyrics result exceeded the response limit".into()); }
        serde_json::from_slice::<Value>(&bytes).map_err(|_| "Invalid alignment result".into())
    }).await;
    if let Ok(mut current) = state.current.lock() {
        if current.as_ref().is_some_and(|(id, _)| id == &job) { *current = None; }
    }
    result.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn lyrics_operation(app: AppHandle, request: Value) -> Result<Value, String> {
    let payload = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    if payload.len() > 65536 { return Err("Lyrics request too large".into()); }
    let path = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("lyrics.sqlite3");
    let argument = format!("--db={}", path.to_string_lossy());
    let (mut cmd, _) = build_engine_cmd(&app, "lyrics", &[&argument])?;
    cmd.stdin(Stdio::piped());
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        child.stdin.take().ok_or("Lyrics input unavailable")?.write_all(&payload).map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().ok_or("Lyrics output unavailable")?;
        let stderr = child.stderr.take().ok_or("Lyrics diagnostics unavailable")?;
        let reader = thread::spawn(move || { let mut data = Vec::new(); stdout.take(8_000_000).read_to_end(&mut data).map(|_| data) });
        let diagnostics = thread::spawn(move || { let mut data = Vec::new(); stderr.take(65536).read_to_end(&mut data).ok(); });
        let start = std::time::Instant::now();
        loop {
            if child.try_wait().map_err(|e| e.to_string())?.is_some() { break; }
            if start.elapsed().as_secs() >= 25 {
                kill_process_tree(child.id());
                let _ = child.wait();
                return Err("Lyrics operation timed out".into());
            }
            thread::sleep(std::time::Duration::from_millis(30));
        }
        let data = reader.join().map_err(|_| "Lyrics reader failed")?.map_err(|e| e.to_string())?;
        let _ = diagnostics.join();
        let value: Value = serde_json::from_slice(&data).map_err(|_| "Invalid lyrics response")?;
        if let Some(error) = value.get("error").and_then(Value::as_str) { return Err(error.to_string()); }
        Ok(value)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn search_youtube(app: AppHandle, query: String) -> Result<Value, String> {
    let query = query.trim();
    if query.chars().count() < 2 || query.chars().count() > 160 || query.chars().any(char::is_control) {
        return Err("Invalid YouTube search query".into());
    }
    let argument = format!("--query={query}");
    let (mut cmd, _) = build_engine_cmd(&app, "youtube-search", &[&argument])?;
    tauri::async_runtime::spawn_blocking(move || {
        let output = cmd.output().map_err(|err| err.to_string())?;
        if !output.status.success() {
            return Err("YouTube search unavailable".into());
        }
        let result: Value = serde_json::from_slice(&output.stdout).map_err(|err| err.to_string())?;
        result.get("videos").cloned().ok_or_else(|| "YouTube search returned an invalid response".into())
    }).await.map_err(|err| err.to_string())?
}

#[tauri::command]
async fn youtube_video_title(id: String) -> Result<String, String> {
    if id.len() != 11 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("Invalid YouTube video ID".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let endpoint = format!("https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D{id}&format=json");
        #[cfg(windows)]
        let curl_path = PathBuf::from(std::env::var_os("SystemRoot").ok_or("Windows system folder unavailable")?)
            .join("System32").join("curl.exe");
        #[cfg(not(windows))]
        let curl_path = PathBuf::from("curl");
        let mut curl = Command::new(curl_path);
        hide_console(&mut curl);
        let output = curl.args(["--disable", "--silent", "--fail", "--max-time", "5", "--max-filesize", "65536", &endpoint])
            .output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err("YouTube title unavailable".into());
        }
        let data: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
        data["title"].as_str().map(str::to_owned).ok_or_else(|| "YouTube title missing".into())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn download_youtube_mp3(
    app: AppHandle,
    state: State<'_, EngineState>,
    url: String,
    dest: String,
    quality: String,
) -> Result<Value, String> {
    kill_child(&state.child);
    let cache = new_job_cache(&app)?;
    let cache_s = cache.to_string_lossy().to_string();
    let q = if quality.is_empty() {
        "high".to_string()
    } else {
        quality
    };
    let (cmd, python) = build_engine_cmd(
        &app,
        "youtube-download-mp3",
        &[&url, "--dest", &dest, "--quality", &q, "--cache-dir", &cache_s],
    )?;
    let result = run_engine_streaming(app, state, cmd, python).await;
    let _ = std::fs::remove_dir_all(&cache);
    result
}

#[tauri::command]
async fn export_mp3(
    app: AppHandle,
    state: State<'_, EngineState>,
    source: String,
    dest: String,
    quality: String,
) -> Result<Value, String> {
    kill_child(&state.child);
    let q = if quality.is_empty() {
        "high".to_string()
    } else {
        quality
    };
    let (cmd, python) = build_engine_cmd(
        &app,
        "export-mp3",
        &["--source", &source, "--dest", &dest, "--quality", &q],
    )?;
    run_engine_streaming(app, state, cmd, python).await
}

#[tauri::command]
fn clear_analysis_cache() -> Result<(), String> {
    let root = std::env::var_os("LOCALAPPDATA").ok_or("Local app data folder unavailable")?;
    let path = std::path::PathBuf::from(root).join("com.chordai.learn").join("analysis-result.json");
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn cleanup_youtube_cache(app: AppHandle, keep: Option<String>) -> Result<Value, String> {
    let root = app_cache_root(&app)?;
    let keep_path = keep.as_ref().map(PathBuf::from);
    let mut removed = 0u64;
    if root.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&root) {
            for ent in entries.flatten() {
                let p = ent.path();
                // Skip if keep is inside this job dir
                if let Some(ref k) = keep_path {
                    if k.starts_with(&p) {
                        continue;
                    }
                }
                if p.is_dir() {
                    if std::fs::remove_dir_all(&p).is_ok() {
                        removed += 1;
                    }
                } else if std::fs::remove_file(&p).is_ok() {
                    removed += 1;
                }
            }
        }
    }
    Ok(serde_json::json!({ "ok": true, "removed": removed }))
}

/// Quit/replace must not leave source audio behind. Frontend unmount is not
/// reliable when the window is closed, so the process exit path clears it too.
fn clear_youtube_cache_on_exit(app: &AppHandle) {
    if let Ok(root) = app_cache_root(app) {
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[tauri::command]
fn storage_usage(app: AppHandle) -> Result<Value, String> {
    fn walk_bytes(path: &std::path::Path, acc: &mut u64) {
        if let Ok(entries) = std::fs::read_dir(path) {
            for ent in entries.flatten() {
                let p = ent.path();
                if p.is_dir() {
                    walk_bytes(&p, acc);
                } else if let Ok(meta) = ent.metadata() {
                    *acc += meta.len();
                }
            }
        }
    }
    let mut cache_bytes = 0u64;
    if let Ok(root) = app_cache_root(&app) {
        walk_bytes(&root, &mut cache_bytes);
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let legacy = std::path::PathBuf::from(local)
            .join("com.chordai.learn")
            .join("analysis-result.json");
        if let Ok(meta) = std::fs::metadata(&legacy) {
            cache_bytes += meta.len();
        }
    }
    let roots = resource_roots(&app);
    let python = resolve_python(&roots);
    let engine_ready = python.is_file()
        && (is_bundled_engine(&python)
            || resolve_engine_script(&roots).is_some_and(|script| script.is_file()));
    Ok(serde_json::json!({ "cacheBytes": cache_bytes, "engineReady": engine_ready }))
}

#[tauri::command]
fn pick_save_mp3(default_name: Option<String>) -> Result<Option<String>, String> {
    // Frontend uses dialog plugin; this is a thin helper if needed.
    // Kept for completeness — UI typically uses plugin-dialog save.
    let _ = default_name;
    Ok(None)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let previous_panic_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let (Some(local), Some(location)) = (std::env::var_os("LOCALAPPDATA"), info.location()) {
            let path = PathBuf::from(local).join("com.chordai.learn");
            if std::fs::create_dir_all(&path).is_ok() {
                // Record the failing code path without logging user audio or input.
                let diagnostic = format!(
                    "Sion Keys {}\n{:?}\n{}:{}\n{}",
                    env!("CARGO_PKG_VERSION"),
                    std::time::SystemTime::now(),
                    location.file(),
                    location.line(),
                    std::backtrace::Backtrace::force_capture(),
                );
                let _ = std::fs::write(path.join("last-native-panic.txt"), diagnostic);
            }
        }
        previous_panic_hook(info);
    }));
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::UpdateState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AlignmentState::default())
        .manage(EngineState {
            child: Arc::new(Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            updates::check_hearthkeys_update,
            updates::install_hearthkeys_update,
            analyze_file,
            analyze_youtube,
            download_youtube_mp3,
            youtube_video_title,
            search_youtube,
            lyrics_operation,
            align_lyrics,
            cancel_lyrics_alignment,
            export_mp3,
            cleanup_youtube_cache,
            clear_analysis_cache,
            cancel_analysis,
            read_file_bytes,
            path_exists,
            write_text_export,
            storage_usage,
            pick_save_mp3
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                if let Ok(current) = app.state::<AlignmentState>().current.lock() {
                    if let Some((_, running)) = current.as_ref() {
                        use std::sync::atomic::Ordering;
                        running.cancelled.store(true, Ordering::Relaxed);
                        let pid = running.pid.load(Ordering::Relaxed);
                        if pid != 0 { kill_process_tree(pid); }
                    }
                }
                clear_youtube_cache_on_exit(app);
            }
        });
}

#[cfg(test)]
mod text_export_tests {
    use super::*;

    struct TestFolder(PathBuf);
    impl TestFolder {
        fn new(label: &str) -> Self {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .unwrap().as_nanos();
            let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("target")
                .join(format!("text-export-test-{}-{label}-{stamp}", std::process::id()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn assert_entries(&self, expected: usize) {
            assert_eq!(std::fs::read_dir(&self.0).unwrap().count(), expected, "temporary file leaked");
        }
    }
    impl Drop for TestFolder {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn text_export_saves_new_utf8_files_without_temporary_files() {
        let folder = TestFolder::new("new");
        for extension in ["csv", "json", "html", "CSV"] {
            let path = resolve_text_export_path(&folder.0.join(format!("Песен.{extension}"))).unwrap();
            atomic_text_export(&path, "Песен — C♯\n0.001234,Am").unwrap();
            assert_eq!(std::fs::read_to_string(path).unwrap(), "Песен — C♯\n0.001234,Am");
            std::fs::remove_file(folder.0.join(format!("Песен.{extension}"))).unwrap();
        }
        folder.assert_entries(0);
    }

    #[test]
    fn text_export_replaces_existing_without_modifying_other_hard_links() {
        let folder = TestFolder::new("replace");
        let path = folder.0.join("song.json");
        let other = folder.0.join("original.json");
        std::fs::write(&path, "existing content").unwrap();
        std::fs::hard_link(&path, &other).unwrap();
        atomic_text_export(&path, "replacement").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "replacement");
        assert_eq!(std::fs::read_to_string(other).unwrap(), "existing content");
        folder.assert_entries(2);
    }

    #[test]
    fn text_export_partial_write_failure_preserves_existing_and_cleans_temp() {
        let folder = TestFolder::new("write-failure");
        let path = folder.0.join("song.csv");
        std::fs::write(&path, "existing content").unwrap();
        let error = atomic_export_with(&path, |file| {
            file.write_all(b"partial new content")?;
            Err(std::io::Error::other("injected write failure"))
        }).unwrap_err();
        assert!(error.to_string().contains("injected write failure"));
        assert_eq!(std::fs::read_to_string(path).unwrap(), "existing content");
        folder.assert_entries(1);
    }

    #[test]
    fn text_export_finalization_failure_cleans_temp_without_deleting_destination() {
        let folder = TestFolder::new("finalize-failure");
        let path = folder.0.join("song.html");
        let result = atomic_export_with(&path, |file| {
            file.write_all(b"new content")?;
            // Simulate a destination becoming unusable after temporary creation.
            std::fs::create_dir(&path)?;
            std::fs::write(path.join("keep"), "existing content")
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(path.join("keep")).unwrap(), "existing content");
        folder.assert_entries(1);
    }

    #[cfg(windows)]
    #[test]
    fn text_export_windows_rename_failure_preserves_locked_destination() {
        use std::os::windows::fs::OpenOptionsExt;
        let folder = TestFolder::new("rename-failure");
        let path = folder.0.join("song.html");
        std::fs::write(&path, "existing content").unwrap();
        // Allow metadata/read/write access but deny FILE_SHARE_DELETE, so rename fails.
        let lock = std::fs::OpenOptions::new().read(true).share_mode(3).open(&path).unwrap();
        let result = atomic_export_with(&path, |file| {
            folder.assert_entries(2); // The temporary file was actually created.
            check_export_destination(&path)?;
            file.write_all(b"replacement")
        });
        assert!(result.is_err());
        drop(lock);
        assert_eq!(std::fs::read_to_string(path).unwrap(), "existing content");
        folder.assert_entries(1);
    }

    #[test]
    fn text_export_rejects_unsupported_and_unsafe_paths() {
        let folder = TestFolder::new("invalid");
        for name in ["song.mp3", "song.txt", "song", "song.json ", "song.json:stream", "../song.json"] {
            assert!(resolve_text_export_path(&folder.0.join(name)).is_err(), "accepted {name}");
        }
        assert!(resolve_text_export_path(Path::new("song.json")).is_err());
        let directory = folder.0.join("directory.json");
        std::fs::create_dir(&directory).unwrap();
        assert!(resolve_text_export_path(&directory).is_err());
        folder.assert_entries(1);
    }

    #[cfg(unix)]
    #[test]
    fn text_export_rejects_symlink_files_and_folders() {
        use std::os::unix::fs::symlink;
        let folder = TestFolder::new("symlink");
        let original = folder.0.join("original.json");
        let link = folder.0.join("link.json");
        std::fs::write(&original, "existing content").unwrap();
        symlink(&original, &link).unwrap();
        assert!(resolve_text_export_path(&link).is_err());
        assert!(atomic_text_export(&link, "replacement").is_err());
        let linked_folder = folder.0.join("linked-folder");
        symlink(&folder.0, &linked_folder).unwrap();
        assert!(resolve_text_export_path(&linked_folder.join("new.json")).is_err());
        assert_eq!(std::fs::read_to_string(original).unwrap(), "existing content");
        folder.assert_entries(3);
    }
}
