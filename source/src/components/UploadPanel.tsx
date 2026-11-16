import {useEffect,useRef,useState} from 'react';
import type {Mp3Quality} from '../lib/types';
import {Icon} from './Icon';
export function UploadPanel(props: {
  busy: boolean;
  tauri: boolean;
  youtubeUrl: string;
  onYoutubeUrl: (url: string) => void;
  mp3Quality: Mp3Quality;
  onMp3Quality: (q: Mp3Quality) => void;
  onBrowse: () => void;
  onFilePath: (path: string, name: string) => void;
  onAnalyzeYoutube: () => void;
  onDownloadMp3: () => void;
  canAnalyzeYoutube: boolean;
  canDownloadMp3: boolean;
}) {
  const [dragOver,setDragOver]=useState(false);
  const live=useRef(props);live.current=props;
  useEffect(()=>{ if(!props.tauri)return; let closed=false;let off:(()=>void)|undefined;
    void import('@tauri-apps/api/webview').then(async({getCurrentWebview})=>{
      const unlisten=await getCurrentWebview().onDragDropEvent(({payload})=>{
        setDragOver(payload.type==='over'||payload.type==='enter');
        if(payload.type==='drop'&&!live.current.busy&&payload.paths[0]){const path=payload.paths[0];live.current.onFilePath(path,path.split(/[\\/]/).pop()||'Audio');}
      });if(closed)unlisten();else off=unlisten;
    });return()=>{closed=true;off?.();};
  },[props.tauri]);
  return <section className="upload-row"><button className={'drop-zone '+(dragOver?'dragging':'')} disabled={props.busy||!props.tauri} onClick={props.onBrowse}><Icon name="upload" size={48}/><span><strong>Drag &amp; drop an audio file here</strong><small>MP3, WAV, FLAC, M4A, AAC, OGG</small></span></button><span className="or-label">or</span><div className="url-box"><Icon name="link"/><input aria-label="YouTube URL" type="url" placeholder="Paste a YouTube URL (e.g. https://www.youtube.com/watch?v=…)" value={props.youtubeUrl} onChange={e=>props.onYoutubeUrl(e.target.value)} disabled={props.busy}/><button className="btn btn-primary" disabled={props.busy||!props.canAnalyzeYoutube} onClick={props.onAnalyzeYoutube}><Icon name="play" size={20}/>Analyze</button><details className="download-menu"><summary aria-label="Download options" title="Download MP3"><Icon name="download" size={19}/></summary><div><label>MP3 quality<select value={props.mp3Quality} onChange={e=>props.onMp3Quality(e.target.value as Mp3Quality)}><option value="high">High (VBR)</option><option value="192">192 kbps</option><option value="128">128 kbps</option></select></label><button className="btn btn-primary" disabled={props.busy||!props.canDownloadMp3} onClick={props.onDownloadMp3}>Download MP3</button></div></details></div></section>;
}
