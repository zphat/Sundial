//! Sundial desktop shell. The UI lives in ../ui; this file is the thin native layer:
//! file storage with daily backups, tray icon, close-to-tray, system-wide hotkeys,
//! native notifications, start-with-Windows, secrets in the OS credential store,
//! and the bring-your-own-key AI parser.

use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri_plugin_updater::UpdaterExt;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

const SERVICE: &str = "Sundial";
const DB_FILE: &str = "sundial.json";
const BACKUPS_TO_KEEP: usize = 30;

// ---------- storage ----------

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Civil date (UTC) from the system clock, without pulling in a date crate. Only used to name backups.
fn today_utc() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let z = secs.div_euclid(86400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

#[tauri::command]
fn load_db(app: AppHandle) -> Result<Option<String>, String> {
    let p = data_dir(&app)?.join(DB_FILE);
    if !p.exists() {
        return Ok(None);
    }
    fs::read_to_string(&p).map(Some).map_err(|e| e.to_string())
}

/// Atomic write (temp file + rename), then one backup per day, oldest pruned.
#[tauri::command]
fn save_db(app: AppHandle, json: String) -> Result<(), String> {
    let dir = data_dir(&app)?;
    let target = dir.join(DB_FILE);
    let tmp = dir.join(format!("{DB_FILE}.tmp"));
    fs::write(&tmp, json.as_bytes()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &target).map_err(|e| e.to_string())?;

    let backups = dir.join("backups");
    if fs::create_dir_all(&backups).is_ok() {
        let b = backups.join(format!("sundial-{}.json", today_utc()));
        if !b.exists() {
            let _ = fs::copy(&target, &b);
        }
        if let Ok(rd) = fs::read_dir(&backups) {
            let mut files: Vec<PathBuf> = rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
                .collect();
            files.sort();
            while files.len() > BACKUPS_TO_KEEP {
                let old = files.remove(0);
                let _ = fs::remove_file(old);
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn data_path(app: AppHandle) -> Result<String, String> {
    Ok(data_dir(&app)?.join(DB_FILE).to_string_lossy().to_string())
}

#[tauri::command]
fn reveal_data(app: AppHandle) -> Result<(), String> {
    let dir = data_dir(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

// ---------- notifications / autostart ----------

#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn autostart_get(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn autostart_set(app: AppHandle, on: bool) -> Result<(), String> {
    let m = app.autolaunch();
    let r = if on { m.enable() } else { m.disable() };
    r.map_err(|e| e.to_string())
}

// ---------- secrets (Windows Credential Manager via keyring) ----------

fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_set(name: String, value: String) -> Result<(), String> {
    entry(&name)?.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_get(name: String) -> Result<Option<String>, String> {
    match entry(&name)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secret_delete(name: String) -> Result<(), String> {
    match entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---------- system-wide hotkeys ----------

#[derive(Deserialize)]
pub struct HotkeySpec {
    quick: Option<String>,
    voice: Option<String>,
}

/// The UI records combos as "Ctrl+Shift+Space"; the shortcut parser wants "Control+Shift+Space" with key codes.
fn normalize_combo(c: &str) -> String {
    c.split('+')
        .map(|p| {
            let t = p.trim();
            match t {
                "Ctrl" | "Control" => "Control".to_string(),
                "Meta" | "Cmd" | "Win" => "Super".to_string(),
                "Alt" => "Alt".to_string(),
                "Shift" => "Shift".to_string(),
                "Space" | " " => "Space".to_string(),
                "/" => "Slash".to_string(),
                "," => "Comma".to_string(),
                "." => "Period".to_string(),
                ";" => "Semicolon".to_string(),
                "'" => "Quote".to_string(),
                "[" => "BracketLeft".to_string(),
                "]" => "BracketRight".to_string(),
                "\\" => "Backslash".to_string(),
                "-" => "Minus".to_string(),
                "=" => "Equal".to_string(),
                "`" => "Backquote".to_string(),
                s if s.len() == 1 && s.chars().all(|ch| ch.is_ascii_digit()) => format!("Digit{s}"),
                s if s.len() == 1 && s.chars().all(|ch| ch.is_ascii_alphabetic()) => {
                    format!("Key{}", s.to_ascii_uppercase())
                }
                other => other.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join("+")
}

/// Replaces all registered shortcuts. Returns the combos that could not be registered (taken by another app).
#[tauri::command]
fn set_hotkeys(app: AppHandle, spec: HotkeySpec) -> Result<Vec<String>, String> {
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    let mut failed = Vec::new();
    for (combo, event) in [(spec.quick, "sundial://quick-add"), (spec.voice, "sundial://voice")] {
        let Some(c) = combo else { continue };
        let ev = event.to_string();
        let parsed: Result<Shortcut, _> = normalize_combo(&c).parse();
        match parsed {
            Ok(sc) => {
                let r = gs.on_shortcut(sc, move |app, _sc, e| {
                    if e.state == ShortcutState::Pressed {
                        show_main(app);
                        let _ = app.emit(&ev, ());
                    }
                });
                if let Err(e) = r {
                    failed.push(format!("{c}: {e}"));
                }
            }
            Err(e) => failed.push(format!("{c}: {e}")),
        }
    }
    Ok(failed)
}

// ---------- AI parsing with the user's own key ----------

#[derive(Deserialize)]
pub struct AiReq {
    provider: String,
    model: String,
    base_url: Option<String>,
    text: String,
    context: Value,
}

fn task_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "title":  {"type": "string", "description": "the line with scheduling words removed, in the user's own words"},
            "date":   {"type": ["string", "null"], "description": "YYYY-MM-DD, null if the line names no day"},
            "time":   {"type": ["integer", "null"], "description": "minutes after midnight, null if no time"},
            "dur":    {"type": ["integer", "null"], "description": "duration in minutes"},
            "color":  {"type": ["string", "null"], "description": "one of the color keys, null if none fits clearly"},
            "repeat": {"type": ["string", "null"], "enum": ["daily", "weekdays", "weekly", "monthly", null]},
            "remind": {"type": ["integer", "null"], "description": "minutes before start, only if the line asks for a reminder lead"},
            "notify": {"type": ["boolean", "null"], "description": "false only if the line says silent/quiet/no alert"},
            "notes":  {"type": ["string", "null"], "description": "details worth keeping out of the title: address, names, links, what to bring"}
        },
        "required": ["title", "date", "time", "dur", "color", "repeat", "remind", "notify", "notes"],
        "additionalProperties": false
    })
}

fn system_prompt(ctx: &Value) -> String {
    let s = |k: &str| ctx[k].as_str().unwrap_or("").to_string();
    format!(
        "You turn one line typed into a personal planner into fields. Today is {today} ({weekday}), local time {now}. \
The day currently selected in the app is {selected}; use it when the line names no day. \
Color keys and what the user calls them: {labels}. \
Rules: keep the title in the user's words with scheduling words removed. Times are minutes after midnight; \
a bare small number like 'at 3' for a daytime errand means afternoon. Durations in minutes. \
Set only what the line actually implies, otherwise null. Details that are not the task itself (address, names, \
links, what to bring, why) go into notes. Never invent dates, times or people.",
        today = s("today"),
        weekday = s("weekday"),
        now = s("now"),
        selected = s("selected"),
        labels = ctx["labels"].to_string()
    )
}

#[tauri::command]
async fn ai_parse(req: AiReq) -> Result<Value, String> {
    let key = secret_get(format!("ai:{}", req.provider))?
        .ok_or_else(|| "No API key saved for this provider".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(40))
        .build()
        .map_err(|e| e.to_string())?;
    let system = system_prompt(&req.context);
    let schema = task_schema();

    if req.provider == "anthropic" {
        // Server-side refusal fallback is only accepted by the models that support it.
        let fallback_ok = ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable"]
            .iter()
            .any(|p| req.model.starts_with(p));
        let mut body = json!({
            "model": req.model,
            "max_tokens": 1024,
            "system": system,
            "messages": [{"role": "user", "content": req.text}],
            "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": schema}}
        });
        if fallback_ok {
            body["fallbacks"] = json!("default");
        }
        let mut r = client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json");
        if fallback_ok {
            r = r.header("anthropic-beta", "server-side-fallback-2026-07-01");
        }
        let resp = r.json(&body).send().await.map_err(|e| e.to_string())?;
        let status = resp.status();
        let v: Value = resp.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(v["error"]["message"].as_str().unwrap_or("API error").to_string());
        }
        if v["stop_reason"] == "refusal" {
            return Err("The model declined this line".to_string());
        }
        let text = v["content"]
            .as_array()
            .and_then(|a| a.iter().find(|b| b["type"] == "text"))
            .and_then(|b| b["text"].as_str())
            .ok_or("No text in response")?;
        serde_json::from_str::<Value>(text).map_err(|e| format!("Bad JSON from model: {e}"))
    } else {
        let base = req.base_url.clone().filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "https://api.openai.com/v1".to_string());
        let body = json!({
            "model": req.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": req.text}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "task", "schema": schema, "strict": true}}
        });
        let resp = client
            .post(format!("{}/chat/completions", base.trim_end_matches('/')))
            .bearer_auth(&key)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        let v: Value = resp.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(v["error"]["message"].as_str().unwrap_or("API error").to_string());
        }
        let text = v["choices"][0]["message"]["content"].as_str().ok_or("No content in response")?;
        serde_json::from_str::<Value>(text).map_err(|e| format!("Bad JSON from model: {e}"))
    }
}

// ---------- updates ----------

/// The update found by the last check, kept so "Restart now" can install it without checking again.
pub struct PendingUpdate(Mutex<Option<tauri_plugin_updater::Update>>);

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
async fn update_check(app: AppHandle, pending: tauri::State<'_, PendingUpdate>) -> Result<Option<Value>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(u)) => {
            let info = json!({
                "version": u.version,
                "notes": u.body,
                "date": u.date.map(|d| d.to_string()),
            });
            *pending.0.lock().map_err(|e| e.to_string())? = Some(u);
            Ok(Some(info))
        }
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn update_install(app: AppHandle, pending: tauri::State<'_, PendingUpdate>) -> Result<(), String> {
    let update = pending.0.lock().map_err(|e| e.to_string())?.take();
    let Some(update) = update else {
        return Err("No update has been checked yet".to_string());
    };
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart()
}

// ---------- corner toasts (Steam-style notification window) ----------

#[derive(Default)]
pub struct ToastState {
    current: Option<Value>,
    queue: std::collections::VecDeque<Value>,
}
pub struct Toasts(Mutex<ToastState>);

const TOAST_W: f64 = 384.0;
const TOAST_H: f64 = 126.0;

/// A frameless, transparent, always-on-top window in a screen corner. Created per notification so it
/// never takes focus from whatever the user is doing; closed by the page when dismissed or timed out.
fn open_toast_window(app: &AppHandle, payload: &Value) -> Result<(), String> {
    let corner = payload["corner"].as_str().unwrap_or("bottom-left");
    let mon = app
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no monitor".to_string())?;
    let scale = mon.scale_factor();
    let ms = mon.size().to_logical::<f64>(scale);
    let mp = mon.position().to_logical::<f64>(scale);
    let margin = 14.0;
    let taskbar = 52.0; // room for a bottom taskbar; the toast sits just above it
    let x = if corner.ends_with("left") { mp.x + margin } else { mp.x + ms.width - TOAST_W - margin };
    let y = if corner.starts_with("top") { mp.y + margin } else { mp.y + ms.height - TOAST_H - taskbar - margin };
    tauri::WebviewWindowBuilder::new(app, "toast", tauri::WebviewUrl::App("toast.html".into()))
        .title("Sundial notification")
        .inner_size(TOAST_W, TOAST_H)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .shadow(false)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn toast_show(app: AppHandle, state: tauri::State<'_, Toasts>, payload: Value) -> Result<(), String> {
    {
        let mut st = state.0.lock().map_err(|e| e.to_string())?;
        if app.get_webview_window("toast").is_some() {
            st.queue.push_back(payload);
            return Ok(());
        }
        st.current = Some(payload.clone());
    }
    open_toast_window(&app, &payload)
}

#[tauri::command]
fn toast_payload(state: tauri::State<'_, Toasts>) -> Result<Option<Value>, String> {
    Ok(state.0.lock().map_err(|e| e.to_string())?.current.clone())
}

/// The toast page reports what the user did; the main window gets the event, the window closes,
/// and the next queued toast (if any) opens after a beat.
#[tauri::command]
fn toast_action(app: AppHandle, state: tauri::State<'_, Toasts>, action: String) -> Result<(), String> {
    let (current, next) = {
        let mut st = state.0.lock().map_err(|e| e.to_string())?;
        let current = st.current.take();
        let next = st.queue.pop_front();
        st.current = next.clone();
        (current, next)
    };
    if action == "open" || action == "install" {
        show_main(&app);
    }
    if let Some(p) = current {
        let _ = app.emit_to("main", "sundial://toast-action", json!({ "action": action, "payload": p }));
    }
    if let Some(w) = app.get_webview_window("toast") {
        let _ = w.close();
    }
    if let Some(n) = next {
        let app2 = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            let app3 = app2.clone();
            let _ = app2.run_on_main_thread(move || {
                let _ = open_toast_window(&app3, &n);
            });
        });
    }
    Ok(())
}

// ---------- window / tray ----------

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Sundial", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "quick", "Quick add", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Sundial", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quick, &quit])?;
    let mut b = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Sundial")
        .on_menu_event(|app, e| match e.id().as_ref() {
            "open" => show_main(app),
            "quick" => {
                show_main(app);
                let _ = app.emit("sundial://quick-add", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PendingUpdate(Mutex::new(None)))
        .manage(Toasts(Mutex::new(ToastState::default())))
        .setup(|app| {
            build_tray(app)?;
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        // The close button hides to the tray so reminders keep firing; Quit lives in the tray menu.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_db, save_db, data_path, reveal_data, open_url, notify,
            autostart_get, autostart_set, secret_set, secret_get, secret_delete,
            set_hotkeys, ai_parse, app_version, update_check, update_install,
            toast_show, toast_payload, toast_action
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sundial");
}
