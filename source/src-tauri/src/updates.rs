use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct UpdateState {
    installing: AtomicBool,
    checked: Mutex<Option<Update>>,
}

struct InstallGuard<'a>(&'a AtomicBool);

impl Drop for InstallGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

async fn available(app: &AppHandle) -> Result<Option<Update>, String> {
    let mut updater = app.updater_builder()
        .configure_client(|client| client.https_only(true))
        .timeout(Duration::from_secs(120));
    if let (Some(endpoint), Some(pubkey)) = (
        option_env!("HEARTHKEYS_UPDATE_ENDPOINT"),
        option_env!("HEARTHKEYS_UPDATE_PUBLIC_KEY"),
    ) {
        let endpoint = tauri::Url::parse(endpoint).map_err(|_| "Update configuration is invalid.")?;
        if endpoint.scheme() != "https"
            || endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || pubkey.trim().is_empty()
        {
            return Err("Update configuration is invalid.".into());
        }
        updater = updater
            .endpoints(vec![endpoint])
            .map_err(|_| "Update configuration is invalid.")?
            .pubkey(pubkey);
    }
    updater
        .build()
        .map_err(|_| "Update configuration is invalid.")?
        .check()
        .await
        .map_err(|_| "Could not check for updates.".into())
}

#[tauri::command]
pub async fn check_hearthkeys_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<Option<serde_json::Value>, String> {
    *state
        .checked
        .lock()
        .map_err(|_| "Could not check for updates.")? = None;
    let update = available(&app).await?;
    let details = update.as_ref().map(|update| {
        serde_json::json!({
            "version": update.version,
            "notes": update.body,
        })
    });
    *state
        .checked
        .lock()
        .map_err(|_| "Could not check for updates.")? = update;
    Ok(details)
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum UpdateProgress {
    Downloading { received: u64, total: Option<u64> },
    Installing,
}

#[tauri::command]
pub async fn install_hearthkeys_update(
    state: State<'_, UpdateState>,
    version: String,
    on_progress: Channel<UpdateProgress>,
) -> Result<(), String> {
    if state.installing.swap(true, Ordering::Acquire) {
        return Err("An update is already in progress.".into());
    }
    let _guard = InstallGuard(&state.installing);
    let update = state
        .checked
        .lock()
        .map_err(|_| "Could not install the signed update.")?
        .take()
        .filter(|update| update.version == version)
        .ok_or("This update changed. Check for updates again.")?;
    if update.download_url.scheme() != "https" {
        return Err("Update configuration is invalid.".into());
    }
    let mut received = 0_u64;
    let bytes = update
        .download(
            |size, total| {
                received += size as u64;
                let _ = on_progress.send(UpdateProgress::Downloading { received, total });
            },
            || {},
        )
        .await
        .map_err(|_| "Could not download or verify the signed update.")?;
    let _ = on_progress.send(UpdateProgress::Installing);
    update
        .install(bytes)
        .map_err(|_| "Could not install the signed update.".into())
}
