// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup_watch;
mod lid_power;
mod lomoagent;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::io::{self, Read as _};
use std::net::TcpStream;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Bundled executables (resource dir): proxy.exe and lomod\lomod.exe on Windows, proxy and
/// lomod/lomod on macOS.
const PROXY_EXE: &str = if cfg!(windows) { "proxy.exe" } else { "proxy" };
const LOMOD_EXE: &str = if cfg!(windows) { "lomod.exe" } else { "lomod" };

const LOMOD_PORT: u16 = 8000;
const PROXY_PORT: u16 = 3001;

const TRAY_ID: &str = "main-tray";
const TRAY_SHOW_APP_ID: &str = "tray-show-app";
const TRAY_QUIT_ID: &str = "tray-quit";
const TRAY_SLEEP_HINT_ID: &str = "tray-sleep-hint";
const TRAY_LID_BACKUP_ID: &str = "tray-lid-backup";
const TRAY_ICON: tauri::image::Image<'_> = tauri::include_image!("./icons/icon.ico");

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
enum BackendMode {
    #[default]
    Local,
    Remote,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
struct LocalBackendConfig {
    #[serde(default)]
    photos_dir: String,
    #[serde(default)]
    setup_completed: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
struct RemoteBackendConfig {
    #[serde(default)]
    default_url: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
struct AppConfig {
    #[serde(default)]
    active_backend_mode: BackendMode,
    #[serde(default)]
    local: LocalBackendConfig,
    #[serde(default)]
    remote: RemoteBackendConfig,
    #[serde(default)]
    welcome_shown: bool,
    /// Keep phone backups running with the lid closed while plugged in (tray toggle).
    #[serde(default)]
    lid_closed_backup: bool,
    #[serde(default)]
    #[serde(skip_serializing)]
    photos_dir: String,
    #[serde(default)]
    #[serde(skip_serializing)]
    setup_completed: bool,
    #[serde(default)]
    #[serde(skip_serializing)]
    backend_mode: Option<BackendMode>,
    #[serde(default)]
    #[serde(skip_serializing)]
    remote_lomod_url: String,
}

struct AppState {
    lomod_process: Option<Child>,
    proxy_process: Option<Child>,
    resource_dir: PathBuf,
    data_dir: PathBuf,
}

struct TrayState {
    _tray_icon: TrayIcon,
}

#[derive(serde::Serialize, Clone)]
struct LocalLibraryDbUser {
    id: i64,
    user_name: String,
    email: String,
    nick_name: String,
    home_dir: String,
    admin: bool,
    status: i64,
}

#[derive(serde::Serialize, Clone)]
struct LocalLibraryDbCandidate {
    path: String,
    source: String,
    in_selected_folder: bool,
    users: Vec<LocalLibraryDbUser>,
    user_count: usize,
    load_error: Option<String>,
}

/// Strip the `\\?\` extended-length path prefix that Windows/Tauri adds.
/// Node.js and some tools don't handle this prefix correctly.
fn clean_path(p: &std::path::Path) -> PathBuf {
    let s = p.to_string_lossy();
    if s.starts_with(r"\\?\") {
        PathBuf::from(&s[4..])
    } else {
        p.to_path_buf()
    }
}

fn path_str(p: &std::path::Path) -> String {
    clean_path(p).to_string_lossy().to_string()
}

fn proxy_pid_path(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("proxy.pid")
}

fn clear_proxy_pid(data_dir: &std::path::Path) {
    std::fs::remove_file(proxy_pid_path(data_dir)).ok();
}

fn write_proxy_pid(data_dir: &std::path::Path, pid: u32) {
    std::fs::write(proxy_pid_path(data_dir), pid.to_string()).ok();
}

#[cfg(target_os = "windows")]
fn listening_pids_on_port(port: u16) -> Vec<u32> {
    let Ok(output) = hidden_command("netstat")
        .args(["-ano", "-p", "tcp"])
        .output()
    else {
        return Vec::new();
    };

    let port_suffix = format!(":{}", port);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut pids = Vec::new();
    for line in stdout.lines() {
        let columns: Vec<&str> = line.split_whitespace().collect();
        if columns.len() < 5 || !columns[0].eq_ignore_ascii_case("TCP") {
            continue;
        }

        let local_address = columns[1];
        let state = columns[3];
        if !local_address.ends_with(&port_suffix) || !state.eq_ignore_ascii_case("LISTENING") {
            continue;
        }

        if let Ok(pid) = columns[4].parse::<u32>() {
            if !pids.contains(&pid) {
                pids.push(pid);
            }
        }
    }

    pids
}

#[cfg(target_os = "windows")]
fn process_image_name(pid: u32) -> Option<String> {
    let filter = format!("PID eq {}", pid);
    let output = hidden_command("tasklist")
        .args(["/FI", &filter, "/FO", "CSV", "/NH"])
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.lines().next()?.trim();
    if line.is_empty() || line.starts_with("INFO:") {
        return None;
    }

    let stripped = line.strip_prefix('"')?.strip_suffix('"')?;
    stripped.split("\",\"").next().map(|name| name.to_string())
}

#[cfg(target_os = "windows")]
fn kill_stale_proxy(data_dir: &std::path::Path) {
    let pid_path = proxy_pid_path(data_dir);
    let Ok(pid) = std::fs::read_to_string(&pid_path) else {
        return;
    };
    let pid = pid.trim();
    if pid.is_empty() {
        clear_proxy_pid(data_dir);
        return;
    }

    println!("[tauri] Killing stale proxy (pid {})", pid);
    let _ = hidden_command("taskkill")
        .args(["/F", "/PID", pid])
        .output();
    clear_proxy_pid(data_dir);
    std::thread::sleep(std::time::Duration::from_millis(300));
}

#[cfg(not(target_os = "windows"))]
fn kill_stale_proxy(_data_dir: &std::path::Path) {}

#[cfg(target_os = "windows")]
fn ensure_proxy_port_available(data_dir: &std::path::Path, port: u16) -> Result<(), String> {
    kill_stale_proxy(data_dir);

    let listener_pids = listening_pids_on_port(port);
    if listener_pids.is_empty() {
        return Ok(());
    }

    clear_proxy_pid(data_dir);

    for pid in listener_pids {
        match process_image_name(pid) {
            Some(image_name) if image_name.eq_ignore_ascii_case("proxy.exe") => {
                println!(
                    "[tauri] Killing stale proxy listener on port {} (pid {})",
                    port, pid
                );
                let _ = hidden_command("taskkill")
                    .args(["/F", "/PID", &pid.to_string()])
                    .output();
            }
            Some(image_name) => {
                return Err(format!(
                    "Port {} is already in use by pid {} ({})",
                    port, pid, image_name
                ));
            }
            None => {
                return Err(format!(
                    "Port {} is already in use by pid {} (unable to determine process name)",
                    port, pid
                ));
            }
        }
    }

    std::thread::sleep(std::time::Duration::from_millis(300));

    let remaining = listening_pids_on_port(port);
    if remaining.is_empty() {
        return Ok(());
    }

    let details = remaining
        .into_iter()
        .map(|pid| match process_image_name(pid) {
            Some(image_name) => format!("pid {} ({})", pid, image_name),
            None => format!("pid {}", pid),
        })
        .collect::<Vec<_>>()
        .join(", ");

    Err(format!(
        "Port {} is still in use after cleanup: {}",
        port, details
    ))
}

#[cfg(not(target_os = "windows"))]
fn ensure_proxy_port_available(_data_dir: &std::path::Path, _port: u16) -> Result<(), String> {
    Ok(())
}

fn configure_background_child(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(target_os = "windows")]
fn hidden_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    configure_background_child(&mut cmd);
    cmd
}

fn percent_encode_data_url(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn startup_html() -> &'static str {
    r#"<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Starting lomorage</title>
    <style>
      :root {
        color: #242137;
        background: #eeeafc;
        font-family: "Segoe UI", sans-serif;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at 20% 15%, rgba(91, 86, 214, 0.22), transparent 32%),
          linear-gradient(135deg, #f7f4ff 0%, #e6e1f6 100%);
      }
      .card {
        width: 420px;
        padding: 34px 38px 32px;
        border-radius: 28px;
        background: rgba(255, 255, 255, 0.86);
        box-shadow: 0 24px 60px rgba(50, 39, 104, 0.18);
      }
      .brand {
        font-size: 22px;
        font-weight: 700;
        color: #4f46c7;
        letter-spacing: -0.02em;
      }
      .title {
        margin-top: 18px;
        font-size: 26px;
        font-weight: 700;
        letter-spacing: -0.04em;
      }
      .message {
        min-height: 24px;
        margin-top: 10px;
        color: #615c78;
        font-size: 14px;
      }
      .track {
        height: 12px;
        margin-top: 28px;
        overflow: hidden;
        border-radius: 999px;
        background: #ded8f2;
      }
      .bar {
        width: 8%;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, #544de2, #2f80ed);
        transition: width 180ms ease;
      }
      .percent {
        margin-top: 12px;
        color: #4f46c7;
        font-size: 13px;
        font-weight: 700;
        text-align: right;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="brand">lomorage</div>
      <div class="title">Starting your photo library</div>
      <div id="message" class="message">Preparing app data</div>
      <div class="track"><div id="bar" class="bar"></div></div>
      <div id="percent" class="percent">8%</div>
    </main>
    <script>
      window.setStartupProgress = function(percent, message) {
        const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
        document.getElementById('bar').style.width = safePercent + '%';
        document.getElementById('percent').textContent = Math.round(safePercent) + '%';
        document.getElementById('message').textContent = message || '';
      };
    </script>
  </body>
</html>"#
}

/// Create the main window in code (instead of tauri.conf.json) so we can
/// attach an `on_download` handler — downloads then prompt the user with a
/// native "Save As" dialog instead of silently writing to the Downloads dir.
fn create_main_window(app: &tauri::App) -> Option<tauri::WebviewWindow> {
    tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::External("http://localhost:3001".parse().ok()?),
    )
    .title("lomorage")
    .inner_size(1280.0, 800.0)
    .visible(false)
    .resizable(true)
    .devtools(true)
    .on_download(|webview, event| {
        if let tauri::webview::DownloadEvent::Requested { url, destination } = event {
            eprintln!(
                "[tauri] download requested: url={} suggested={}",
                url,
                destination.display()
            );
            let suggested = destination
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "download".to_string());
            let dialog = rfd::FileDialog::new()
                .set_title("Save file")
                .set_file_name(&suggested)
                .set_parent(&webview.window());
            return match dialog.save_file() {
                Some(path) => {
                    eprintln!("[tauri] download destination chosen: {}", path.display());
                    *destination = path;
                    true
                }
                // User cancelled the dialog — abort the download.
                None => {
                    eprintln!("[tauri] download cancelled by user");
                    false
                }
            };
        }
        true
    })
    .build()
    .ok()
}

fn create_startup_window(app: &tauri::App) -> Option<tauri::WebviewWindow> {
    let url = format!(
        "data:text/html;charset=utf-8,{}",
        percent_encode_data_url(startup_html())
    );
    tauri::WebviewWindowBuilder::new(
        app,
        "startup",
        tauri::WebviewUrl::External(url.parse().ok()?),
    )
    .title("Starting lomorage")
    .inner_size(520.0, 360.0)
    .resizable(false)
    .decorations(false)
    .center()
    .build()
    .ok()
}

fn update_startup_progress(app: &tauri::AppHandle, percent: u8, message: &str) {
    if let Some(window) = app.get_webview_window("startup") {
        let message_json = serde_json::to_string(message).unwrap_or_else(|_| "\"\"".into());
        let _ = window.eval(format!(
            "window.setStartupProgress && window.setStartupProgress({}, {});",
            percent, message_json
        ));
    }
}

fn wait_for_proxy_ready(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    false
}

fn open_default_browser(url: &str) -> io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        hidden_command("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn()
            .map(|_| ())
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(url).spawn().map(|_| ())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open").arg(url).spawn().map(|_| ())
    }
}

fn run_startup(
    app: tauri::AppHandle,
    resource_dir: PathBuf,
    data_dir: PathBuf,
) -> Result<(), io::Error> {
    update_startup_progress(&app, 8, "Preparing app data");
    std::fs::create_dir_all(&data_dir).ok();

    println!("[tauri] Resource dir: {:?}", resource_dir);
    println!("[tauri] Data dir: {:?}", data_dir);

    // Write debug log
    let log_path = data_dir.join("tauri-debug.log");
    let clean_resource = clean_path(&resource_dir);
    let clean_data = clean_path(&data_dir);
    let web_path = clean_data.join("web");
    let proxy_path = clean_resource.join(PROXY_EXE);
    let log_content = format!(
        "resource_dir (raw): {:?}\nresource_dir (clean): {:?}\ndata_dir: {:?}\nweb_dir: {:?}\nweb_dir exists: {}\nproxy.exe exists: {}\nindex.html exists: {}\n",
        resource_dir,
        clean_resource,
        clean_data,
        web_path,
        web_path.exists(),
        proxy_path.exists(),
        web_path.join("index.html").exists(),
    );
    std::fs::write(&log_path, &log_content).ok();
    println!("[tauri] Debug log written to {:?}", log_path);

    let config = get_app_config(&data_dir);
    let photos_dir = resolved_local_photos_dir(&data_dir, &config);
    std::fs::create_dir_all(&photos_dir).ok();
    println!("[tauri] Photos dir: {:?}", photos_dir);
    println!(
        "[tauri] Backend mode: {}",
        match config.active_backend_mode {
            BackendMode::Local => "local",
            BackendMode::Remote => "remote",
        }
    );

    update_startup_progress(&app, 18, "Checking previous web service");
    ensure_proxy_port_available(&data_dir, 3001)
        .map_err(|message| io::Error::new(io::ErrorKind::AddrInUse, message))?;

    update_startup_progress(&app, 34, "Loading web assets");
    let web_dir = extract_web_zip(&resource_dir, &data_dir)
        .map_err(|message| io::Error::new(io::ErrorKind::Other, message))?;
    let post_extract_log = format!(
        "{}post_extract_web_dir: {:?}\npost_extract_web_dir exists: {}\npost_extract_index.html exists: {}\n",
        log_content,
        web_dir,
        web_dir.exists(),
        web_dir.join("index.html").exists(),
    );
    std::fs::write(&log_path, post_extract_log).ok();

    // Only a lomod this app left running is stopped (it used to be every lomod.exe, Lomoagent's too: the viewer
    // then served the phones from a second database).
    update_startup_progress(&app, 48, "Cleaning up previous local backend");
    kill_stale_lomod(&data_dir);

    let lomod = if let Some(agent) = agent_backend(&config) {
        update_startup_progress(&app, 60, "Connecting to Lomoagent's backend");
        println!(
            "[tauri] Lomoagent runs the backend: using its lomod and database {:?}",
            agent.assets_db()
        );
        lomoagent::ensure_running(&agent, LOMOD_PORT, Duration::from_secs(90));
        None
    } else if config.active_backend_mode == BackendMode::Local {
        update_startup_progress(&app, 60, "Starting local backend");
        start_lomod(&resource_dir, &data_dir, &photos_dir)
    } else {
        None
    };

    update_startup_progress(&app, 76, "Starting web service");
    let proxy = start_proxy(&resource_dir, &data_dir, &backend_url_from_config(&config))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::AddrInUse,
                "Failed to start proxy on port 3001. Check proxy-err.log for details.",
            )
        })?;

    update_startup_progress(&app, 88, "Waiting for web service");
    if !wait_for_proxy_ready(3001, Duration::from_secs(8)) {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "Timed out waiting for proxy on port 3001",
        ));
    }

    app.manage(Mutex::new(AppState {
        lomod_process: lomod,
        proxy_process: Some(proxy),
        resource_dir: clean_path(&resource_dir),
        data_dir: clean_path(&data_dir),
    }));

    update_startup_progress(&app, 96, "Opening viewer");
    // On first ever launch, show the welcome wizard in both the app and browser.
    let mut config = get_app_config(&data_dir);
    let start_path = if !config.welcome_shown {
        config.welcome_shown = true;
        if let Err(e) = save_config(&data_dir, &config) {
            eprintln!("[tauri] Failed to save welcome_shown: {}", e);
        }
        "/lomo-welcome"
    } else {
        "/"
    };
    let start_url = format!("http://localhost:3001{}", start_path);

    if let Some(main) = app.get_webview_window("main") {
        let parsed_url = start_url
            .parse()
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
        let _ = main.navigate(parsed_url);
        let _ = main.show();
        let _ = main.set_focus();

        #[cfg(debug_assertions)]
        main.open_devtools();
    }

    update_startup_progress(&app, 100, "Ready");
    std::thread::sleep(Duration::from_millis(180));
    if let Some(startup) = app.get_webview_window("startup") {
        let _ = startup.close();
    }

    Ok(())
}

fn normalize_remote_lomod_url(value: &str) -> String {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }

    if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{}", trimmed)
    }
}

fn backend_url_from_config(config: &AppConfig) -> String {
    match config.active_backend_mode {
        BackendMode::Local => "http://localhost:8000".to_string(),
        BackendMode::Remote => {
            let normalized = normalize_remote_lomod_url(&config.remote.default_url);
            if normalized.is_empty() {
                "http://localhost:8000".to_string()
            } else {
                normalized
            }
        }
    }
}

fn parse_backend_mode(value: &str) -> Result<BackendMode, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "local" => Ok(BackendMode::Local),
        "remote" => Ok(BackendMode::Remote),
        other => Err(format!("Unsupported backend mode: {}", other)),
    }
}

fn config_path(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("config.json")
}

fn normalize_config(mut config: AppConfig, data_dir: &std::path::Path) -> AppConfig {
    if let Some(mode) = config.backend_mode {
        config.active_backend_mode = mode;
    }

    if config.local.photos_dir.trim().is_empty() && !config.photos_dir.trim().is_empty() {
        config.local.photos_dir = config.photos_dir.clone();
    }
    if !config.local.setup_completed && config.setup_completed {
        config.local.setup_completed = true;
    }
    if config.remote.default_url.trim().is_empty() && !config.remote_lomod_url.trim().is_empty() {
        config.remote.default_url = config.remote_lomod_url.clone();
    }

    config.remote.default_url = normalize_remote_lomod_url(&config.remote.default_url);

    if config.local.photos_dir.trim().is_empty() {
        config.local.photos_dir = path_str(&default_photos_dir(data_dir));
    }

    config.photos_dir = config.local.photos_dir.clone();
    config.setup_completed = config.local.setup_completed;
    config.backend_mode = Some(config.active_backend_mode);
    config.remote_lomod_url = config.remote.default_url.clone();

    config
}

fn runtime_data_dir(data_dir: &std::path::Path) -> PathBuf {
    clean_path(&data_dir.join("data"))
}

/// Lomoagent, when it is installed and the local backend is chosen: then its lomod is the backend and its
/// database the library (see lomoagent.rs); the viewer never starts a lomod of its own.
fn agent_backend(config: &AppConfig) -> Option<lomoagent::Installation> {
    if config.active_backend_mode == BackendMode::Local {
        lomoagent::installation()
    } else {
        None
    }
}

/// The database of the local backend: Lomoagent's when it runs the backend, else the viewer's own.
fn assets_db_path(data_dir: &std::path::Path) -> PathBuf {
    if let Some(agent) = agent_backend(&get_app_config(data_dir)) {
        return clean_path(&agent.assets_db());
    }
    runtime_data_dir(data_dir).join("var").join("assets.db")
}

/// A library's identity (conf.uuid): a copy of a database has the uuid of the database it was copied from.
fn library_uuid(db_path: &std::path::Path) -> Option<String> {
    let conn = open_assets_db_at(db_path).ok()?;
    conn.query_row("SELECT value FROM conf WHERE key = 'uuid'", [], |row| {
        row.get::<_, String>(0)
    })
    .optional()
    .ok()
    .flatten()
    .filter(|uuid| !uuid.trim().is_empty())
}

/// The selected database is the agent's own, or a copy of it (the nightly copies in each user's folder).
fn is_agent_library(agent: &lomoagent::Installation, db_path: &std::path::Path) -> bool {
    let agent_db = clean_path(&agent.assets_db());
    if path_matches(&agent_db, db_path) {
        return true;
    }
    match (library_uuid(&agent_db), library_uuid(db_path)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

fn agent_backend_message(agent: &lomoagent::Installation) -> String {
    format!(
        "Lomoagent runs the Lomorage backend on this computer (its library is {}). The viewer uses that \
         library; a second one would make the phones upload photos twice. Change folders and libraries in \
         Lomoagent.",
        path_str(&agent.assets_db())
    )
}

fn default_lomoware_assets_db_paths() -> Vec<PathBuf> {
    let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") else {
        return Vec::new();
    };

    let base = PathBuf::from(local_app_data);
    [base.join("Lomoware"), base.join("lomoware")]
        .into_iter()
        .map(|path| clean_path(&path.join("var").join("assets.db")))
        .filter(|path| path.is_file())
        .collect()
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    let next = path_str(&path).to_lowercase();
    if !paths
        .iter()
        .any(|existing| path_str(existing).to_lowercase() == next)
    {
        paths.push(path);
    }
}

fn unique_runtime_data_backup_path(data_dir: &std::path::Path) -> PathBuf {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);

    for attempt in 0..100 {
        let candidate = if attempt == 0 {
            data_dir.join(format!("data.backup-{}", millis))
        } else {
            data_dir.join(format!("data.backup-{}-{}", millis, attempt))
        };
        if !candidate.exists() {
            return clean_path(&candidate);
        }
    }

    clean_path(&data_dir.join(format!("data.backup-{}-overflow", millis)))
}

fn backup_runtime_data_dir(data_dir: &std::path::Path) -> Result<Option<PathBuf>, String> {
    let runtime_dir = runtime_data_dir(data_dir);
    if !runtime_dir.exists() {
        return Ok(None);
    }

    let backup_dir = unique_runtime_data_backup_path(data_dir);
    std::fs::rename(&runtime_dir, &backup_dir).map_err(|e| {
        format!(
            "Failed to back up existing local backend data from {} to {}: {}",
            runtime_dir.display(),
            backup_dir.display(),
            e
        )
    })?;

    Ok(Some(backup_dir))
}

fn restore_runtime_data_dir(
    data_dir: &std::path::Path,
    backup_dir: Option<&std::path::Path>,
) -> Result<(), String> {
    let runtime_dir = runtime_data_dir(data_dir);
    if runtime_dir.exists() {
        std::fs::remove_dir_all(&runtime_dir).map_err(|e| {
            format!(
                "Failed to remove incomplete local backend data at {}: {}",
                runtime_dir.display(),
                e
            )
        })?;
    }

    if let Some(backup_dir) = backup_dir {
        if backup_dir.exists() {
            std::fs::rename(backup_dir, &runtime_dir).map_err(|e| {
                format!(
                    "Failed to restore previous local backend data from {} to {}: {}",
                    backup_dir.display(),
                    runtime_dir.display(),
                    e
                )
            })?;
        }
    }

    Ok(())
}

fn local_library_assets_db_paths(photos_dir: &std::path::Path) -> Vec<PathBuf> {
    let normalized_dir = clean_path(photos_dir);
    if !normalized_dir.exists() || !normalized_dir.is_dir() {
        return Vec::new();
    }

    let mut matches = Vec::new();
    let root_db = normalized_dir.join("assets.db");
    if root_db.is_file() {
        matches.push(clean_path(&root_db));
    }

    if let Ok(entries) = std::fs::read_dir(&normalized_dir) {
        for entry in entries.flatten() {
            let child_path = entry.path();
            if !child_path.is_dir() {
                continue;
            }

            let child_db = child_path.join("assets.db");
            if child_db.is_file() {
                matches.push(clean_path(&child_db));
            }
        }
    }

    matches.sort();
    matches.dedup();
    matches
}

fn local_library_db_paths(
    data_dir: &std::path::Path,
    photos_dir: &std::path::Path,
) -> Vec<PathBuf> {
    let mut matches = Vec::new();

    for path in default_lomoware_assets_db_paths() {
        push_unique_path(&mut matches, path);
    }

    let runtime_db_path = assets_db_path(data_dir);
    if runtime_db_path.is_file() {
        push_unique_path(&mut matches, clean_path(&runtime_db_path));
    }

    for path in local_library_assets_db_paths(photos_dir) {
        push_unique_path(&mut matches, path);
    }

    matches
}

fn db_is_in_selected_folder(photos_dir: &std::path::Path, db_path: &std::path::Path) -> bool {
    let db = path_str(db_path).replace('/', "\\").to_lowercase();
    let photos_prefix =
        format!("{}\\", path_str(&clean_path(photos_dir)).replace('/', "\\")).to_lowercase();
    !photos_prefix.is_empty() && db.starts_with(&photos_prefix)
}

fn assets_db_source(
    data_dir: &std::path::Path,
    photos_dir: &std::path::Path,
    db_path: &std::path::Path,
) -> String {
    let db = path_str(db_path).to_lowercase();

    if default_lomoware_assets_db_paths()
        .iter()
        .any(|path| path_str(path).to_lowercase() == db)
    {
        return "Default Lomoware database".into();
    }

    if path_str(&assets_db_path(data_dir)).to_lowercase() == db {
        return "Current runtime database".into();
    }

    if db_is_in_selected_folder(photos_dir, db_path) {
        return "Selected folder database".into();
    }

    "Local database".into()
}

fn open_assets_db_at(db_path: &std::path::Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Failed to open {}: {}", db_path.display(), e))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("Failed to set SQLite timeout: {}", e))?;
    Ok(conn)
}

fn local_library_db_users(db_path: &std::path::Path) -> Result<Vec<LocalLibraryDbUser>, String> {
    if !db_path.is_file() {
        return Err(format!("{} does not exist", db_path.display()));
    }

    let conn = open_assets_db_at(db_path)?;
    let mut statement = conn
        .prepare(
            "SELECT id, user_name, email, nick_name, home_dir, admin, status
             FROM user
             WHERE TRIM(COALESCE(user_name, '')) <> ''
               AND TRIM(COALESCE(home_dir, '')) <> ''
             ORDER BY CASE WHEN admin <> 0 THEN 0 ELSE 1 END, user_name",
        )
        .map_err(|e| format!("Failed to read users from {}: {}", db_path.display(), e))?;

    let rows = statement
        .query_map([], |row| {
            let admin: i64 = row.get(5)?;
            Ok(LocalLibraryDbUser {
                id: row.get(0)?,
                user_name: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                email: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                nick_name: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                home_dir: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                admin: admin != 0,
                status: row.get(6)?,
            })
        })
        .map_err(|e| format!("Failed to query users from {}: {}", db_path.display(), e))?;

    let mut users = Vec::new();
    for row in rows {
        users.push(row.map_err(|e| format!("Failed to read a local user: {}", e))?);
    }

    Ok(users)
}

fn local_library_db_candidates(
    data_dir: &std::path::Path,
    photos_dir: &std::path::Path,
) -> Vec<LocalLibraryDbCandidate> {
    local_library_db_paths(data_dir, photos_dir)
        .into_iter()
        .map(|db_path| {
            let source = assets_db_source(data_dir, photos_dir, &db_path);
            let in_selected_folder = db_is_in_selected_folder(photos_dir, &db_path);
            match local_library_db_users(&db_path) {
                Ok(users) => {
                    let user_count = users.len();
                    LocalLibraryDbCandidate {
                        path: path_str(&db_path),
                        source,
                        in_selected_folder,
                        users,
                        user_count,
                        load_error: None,
                    }
                }
                Err(error) => LocalLibraryDbCandidate {
                    path: path_str(&db_path),
                    source,
                    in_selected_folder,
                    users: Vec::new(),
                    user_count: 0,
                    load_error: Some(error),
                },
            }
        })
        .collect()
}

fn selected_local_library_user(
    db_path: &std::path::Path,
    user_name: Option<&str>,
) -> Result<LocalLibraryDbUser, String> {
    let users = local_library_db_users(db_path)?;
    if users.is_empty() {
        return Err(format!(
            "No local users were found in {}",
            path_str(db_path)
        ));
    }

    if let Some(user_name) = user_name.map(str::trim).filter(|value| !value.is_empty()) {
        users
            .into_iter()
            .find(|user| user.user_name.eq_ignore_ascii_case(user_name))
            .ok_or_else(|| {
                format!(
                    "User '{}' was not found in {}",
                    user_name,
                    path_str(db_path)
                )
            })
    } else {
        Ok(users[0].clone())
    }
}

fn path_matches(a: &std::path::Path, b: &std::path::Path) -> bool {
    path_str(a).to_lowercase() == path_str(b).to_lowercase()
}

/// Two spellings of one folder: case, separators and a trailing separator aside ("L:" and "L:\").
fn same_dir(a: &std::path::Path, b: &std::path::Path) -> bool {
    let norm = |p: &std::path::Path| {
        path_str(p)
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    };
    norm(a) == norm(b)
}

fn sqlite_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn copy_assets_db_snapshot(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    if path_matches(source, target) {
        return Ok(());
    }

    let parent = target
        .parent()
        .ok_or_else(|| format!("Invalid target database path: {}", target.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;

    let tmp_target = target.with_extension("assets.db.tmp");
    if tmp_target.exists() {
        std::fs::remove_file(&tmp_target)
            .map_err(|e| format!("Failed to remove stale {}: {}", tmp_target.display(), e))?;
    }

    let conn = open_assets_db_at(source)?;
    conn.execute_batch(&format!(
        "VACUUM INTO {};",
        sqlite_string_literal(&path_str(&tmp_target))
    ))
    .map_err(|e| {
        format!(
            "Failed to copy {} to {}: {}",
            source.display(),
            tmp_target.display(),
            e
        )
    })?;

    if target.exists() {
        std::fs::remove_file(target)
            .map_err(|e| format!("Failed to replace {}: {}", target.display(), e))?;
    }
    std::fs::rename(&tmp_target, target).map_err(|e| {
        format!(
            "Failed to move {} to {}: {}",
            tmp_target.display(),
            target.display(),
            e
        )
    })?;

    Ok(())
}

fn load_config(data_dir: &std::path::Path) -> Option<AppConfig> {
    let path = config_path(data_dir);
    let content = std::fs::read_to_string(&path).ok()?;
    let config: AppConfig = serde_json::from_str(&content).ok()?;
    Some(normalize_config(config, data_dir))
}

fn save_config(data_dir: &std::path::Path, config: &AppConfig) -> Result<(), String> {
    let path = config_path(data_dir);
    let normalized = normalize_config(config.clone(), data_dir);
    let json = serde_json::to_string_pretty(&normalized)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    Ok(())
}

fn default_photos_dir(data_dir: &std::path::Path) -> PathBuf {
    clean_path(&data_dir.join("photos"))
}

fn get_app_config(data_dir: &std::path::Path) -> AppConfig {
    normalize_config(load_config(data_dir).unwrap_or_default(), data_dir)
}

fn open_assets_db(data_dir: &std::path::Path) -> Result<Connection, String> {
    let db_path = assets_db_path(data_dir);
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("Failed to open {}: {}", db_path.display(), e))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("Failed to set SQLite timeout: {}", e))?;
    Ok(conn)
}

fn local_user_exists(data_dir: &std::path::Path) -> Result<bool, String> {
    let db_path = assets_db_path(data_dir);
    if !db_path.exists() {
        return Ok(false);
    }

    // read-only: this may be the database of Lomoagent's running lomod
    let conn = open_assets_db_at(&db_path)?;
    let count: i64 = conn
        .query_row("SELECT COUNT(1) FROM user", [], |row| row.get(0))
        .map_err(|e| format!("Failed to query local users: {}", e))?;
    Ok(count > 0)
}

fn primary_user_home_dir(data_dir: &std::path::Path) -> Result<Option<String>, String> {
    let db_path = assets_db_path(data_dir);
    if !db_path.exists() {
        return Ok(None);
    }

    let conn = open_assets_db_at(&db_path)?;
    conn.query_row(
        "SELECT home_dir
         FROM user
         WHERE TRIM(COALESCE(home_dir, '')) <> ''
         ORDER BY CASE WHEN user_name = 'admin' THEN 0 ELSE 1 END, user_name
         LIMIT 1",
        [],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("Failed to query local user home_dir: {}", e))
}

fn photos_dir_from_home_dir(home_dir: &str) -> Option<PathBuf> {
    let trimmed = home_dir.trim();
    if trimmed.is_empty() {
        return None;
    }

    let parent = PathBuf::from(trimmed).parent()?.to_path_buf();
    Some(clean_path(&parent))
}

fn runtime_local_photos_dir(data_dir: &std::path::Path) -> Result<Option<PathBuf>, String> {
    Ok(primary_user_home_dir(data_dir)?.and_then(|home_dir| photos_dir_from_home_dir(&home_dir)))
}

fn local_setup_completed(data_dir: &std::path::Path, config: &AppConfig) -> bool {
    match local_user_exists(data_dir) {
        Ok(exists) => exists,
        Err(error) => {
            eprintln!(
                "[tauri] Failed to inspect runtime assets.db, falling back to config: {}",
                error
            );
            config.local.setup_completed
        }
    }
}

fn resolved_local_photos_dir(data_dir: &std::path::Path, config: &AppConfig) -> PathBuf {
    match runtime_local_photos_dir(data_dir) {
        Ok(Some(path)) => path,
        Ok(None) => photos_dir_from_config(config, data_dir),
        Err(error) => {
            eprintln!(
                "[tauri] Failed to resolve runtime local photos dir, using config value: {}",
                error
            );
            photos_dir_from_config(config, data_dir)
        }
    }
}

fn app_settings_json(data_dir: &std::path::Path) -> serde_json::Value {
    let config = get_app_config(data_dir);
    let resolved_photos_dir = path_str(&resolved_local_photos_dir(data_dir, &config));
    let local_setup_completed = local_setup_completed(data_dir, &config);
    let needs_local_setup =
        config.active_backend_mode == BackendMode::Local && !local_setup_completed;
    serde_json::json!({
        "active_backend_mode": config.active_backend_mode,
        "backend_mode": config.active_backend_mode,
        "photos_dir": resolved_photos_dir,
        "setup_completed": local_setup_completed,
        "needs_local_setup": needs_local_setup,
        "welcome_shown": config.welcome_shown,
        "remote_lomod_url": config.remote.default_url.clone(),
        "local": {
            "photos_dir": resolved_photos_dir,
            "setup_completed": local_setup_completed,
        },
        "remote": {
            "default_url": config.remote.default_url.clone(),
        },
        "setup_required": needs_local_setup,
    })
}

fn is_initial_setup_complete(data_dir: &std::path::Path) -> bool {
    local_setup_completed(data_dir, &get_app_config(data_dir))
}

fn update_admin_home_dir(
    data_dir: &std::path::Path,
    home_dir: &std::path::Path,
) -> Result<bool, String> {
    let db_path = assets_db_path(data_dir);
    if !db_path.exists() {
        return Ok(false);
    }

    let normalized_home_dir = path_str(home_dir).replace('\\', "/");
    let conn = open_assets_db(data_dir)?;

    let updated = conn
        .execute(
            "UPDATE user SET home_dir = ?1 WHERE user_name = 'admin'",
            params![normalized_home_dir],
        )
        .map_err(|e| format!("Failed to update admin home_dir: {}", e))?;

    if updated == 0 {
        return Ok(false);
    }

    let stored_home_dir: String = conn
        .query_row(
            "SELECT home_dir FROM user WHERE user_name = 'admin'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to verify admin home_dir: {}", e))?;

    if stored_home_dir != normalized_home_dir {
        return Err(format!(
            "admin home_dir verification mismatch: expected {}, found {}",
            normalized_home_dir, stored_home_dir
        ));
    }

    Ok(true)
}

fn photos_dir_from_config(config: &AppConfig, data_dir: &std::path::Path) -> PathBuf {
    if config.local.photos_dir.trim().is_empty() {
        default_photos_dir(data_dir)
    } else {
        PathBuf::from(&config.local.photos_dir)
    }
}

fn get_photos_dir(data_dir: &std::path::Path) -> PathBuf {
    let config = get_app_config(data_dir);
    resolved_local_photos_dir(data_dir, &config)
}

fn start_lomod(
    resource_dir: &std::path::Path,
    data_dir: &std::path::Path,
    photos_dir: &std::path::Path,
) -> Option<Child> {
    // One backend, one database: never a lomod of our own beside Lomoagent's, or beside any lomod that already
    // answers on the port (it would not get the port, but would still open its database and the photo folder).
    if agent_backend(&get_app_config(data_dir)).is_some() {
        println!("[tauri] Lomoagent runs lomod on this computer: not starting a second one");
        return None;
    }
    if lomoagent::port_open(LOMOD_PORT) {
        println!(
            "[tauri] A lomod already answers on port {}: using it, not starting a second one",
            LOMOD_PORT
        );
        return None;
    }

    let lomod_dir = clean_path(&resource_dir.join("lomod"));
    let lomod_exe = lomod_dir.join(LOMOD_EXE);

    if !lomod_exe.exists() {
        eprintln!("[tauri] {} not found at {:?}, skipping", LOMOD_EXE, lomod_exe);
        return None;
    }

    let mount_dir = clean_path(photos_dir);
    let base_dir = runtime_data_dir(data_dir);

    std::fs::create_dir_all(&mount_dir).ok();
    std::fs::create_dir_all(&base_dir).ok();

    println!("[tauri] Starting lomod: {:?}", lomod_exe);
    println!("[tauri]   mount-dir: {:?}", mount_dir);
    println!("[tauri]   base: {:?}", base_dir);
    println!("[tauri]   exe-dir: {:?}", lomod_dir);

    let mut cmd = Command::new(&lomod_exe);
    cmd.args([
        "--mount-dir",
        &path_str(&mount_dir),
        "--base",
        &path_str(&base_dir),
        "--exe-dir",
        &path_str(&lomod_dir),
        "--port",
        &LOMOD_PORT.to_string(),
        "--admin-token",
        "123456",
    ]);
    configure_background_child(&mut cmd);

    match cmd.spawn() {
        Ok(child) => {
            println!("[tauri] lomod started (pid {})", child.id());
            write_lomod_pid(data_dir, child.id());
            Some(child)
        }
        Err(e) => {
            eprintln!("[tauri] Failed to start lomod: {}", e);
            None
        }
    }
}

fn lomod_pid_path(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("lomod.pid")
}

fn write_lomod_pid(data_dir: &std::path::Path, pid: u32) {
    std::fs::write(lomod_pid_path(data_dir), pid.to_string()).ok();
}

/// A lomod this app started and did not stop (it crashed or was killed): stopped. Only that one: a lomod run by
/// Lomoagent or anyone else is left alone.
#[cfg(target_os = "windows")]
fn kill_stale_lomod(data_dir: &std::path::Path) {
    let pid_path = lomod_pid_path(data_dir);
    let pid = std::fs::read_to_string(&pid_path).unwrap_or_default();
    std::fs::remove_file(&pid_path).ok();
    let Ok(pid) = pid.trim().parse::<u32>() else {
        return;
    };
    // the pid may have been reused by another program since
    let Some(image_name) = process_image_name(pid) else {
        return;
    };
    if !image_name.eq_ignore_ascii_case(LOMOD_EXE) {
        return;
    }
    println!("[tauri] Stopping the lomod this app left running (pid {})", pid);
    let _ = hidden_command("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .output();
    std::thread::sleep(Duration::from_millis(300));
}

#[cfg(not(target_os = "windows"))]
fn kill_stale_lomod(_data_dir: &std::path::Path) {}

/// Extract web.zip from resources to data_dir/web if not already extracted
/// or if the zip is newer than the extracted directory.
fn extract_web_zip(
    resource_dir: &std::path::Path,
    data_dir: &std::path::Path,
) -> Result<PathBuf, String> {
    let zip_path = clean_path(&resource_dir.join("web.zip"));
    let web_dir = data_dir.join("web");
    let marker = web_dir.join(".extracted");
    let staging_dir = data_dir.join("web.__extracting");
    let backup_dir = data_dir.join("web.__previous");

    if !zip_path.exists() {
        return Err(format!("web.zip not found at {:?}", zip_path));
    }

    let needs_extract = if marker.exists() && web_dir.join("index.html").exists() {
        let zip_modified = std::fs::metadata(&zip_path)
            .ok()
            .and_then(|m| m.modified().ok());
        let marker_modified = std::fs::metadata(&marker)
            .ok()
            .and_then(|m| m.modified().ok());
        match (zip_modified, marker_modified) {
            (Some(z), Some(m)) => z > m,
            _ => true,
        }
    } else {
        true
    };

    if needs_extract {
        println!("[tauri] Extracting web.zip to {:?}", web_dir);
        if staging_dir.exists() {
            std::fs::remove_dir_all(&staging_dir).map_err(|e| {
                format!("Failed to remove staging web dir {:?}: {}", staging_dir, e)
            })?;
        }
        std::fs::create_dir_all(&staging_dir)
            .map_err(|e| format!("Failed to create staging web dir {:?}: {}", staging_dir, e))?;

        do_extract_zip(&zip_path, &staging_dir)
            .map_err(|e| format!("Failed to extract web.zip: {}", e))?;

        if !staging_dir.join("index.html").exists() {
            std::fs::remove_dir_all(&staging_dir).ok();
            return Err(format!(
                "Extracted web.zip but index.html was missing from {:?}",
                staging_dir
            ));
        }

        if backup_dir.exists() {
            std::fs::remove_dir_all(&backup_dir).map_err(|e| {
                format!(
                    "Failed to remove previous web backup {:?}: {}",
                    backup_dir, e
                )
            })?;
        }

        if web_dir.exists() {
            std::fs::rename(&web_dir, &backup_dir)
                .map_err(|e| format!("Failed to move existing web dir {:?}: {}", web_dir, e))?;
        }

        if let Err(error) = std::fs::rename(&staging_dir, &web_dir) {
            if backup_dir.exists() && !web_dir.exists() {
                let _ = std::fs::rename(&backup_dir, &web_dir);
            }
            return Err(format!(
                "Failed to activate extracted web frontend from {:?} to {:?}: {}",
                staging_dir, web_dir, error
            ));
        }

        std::fs::write(&marker, "ok")
            .map_err(|e| format!("Failed to write extraction marker {:?}: {}", marker, e))?;
        std::fs::remove_dir_all(&backup_dir).ok();
        println!("[tauri] Web files extracted successfully");
    } else {
        println!("[tauri] Web files already extracted, skipping");
    }

    if !web_dir.join("index.html").exists() {
        return Err(format!(
            "Web frontend missing after extraction at {:?}",
            web_dir.join("index.html")
        ));
    }

    Ok(web_dir)
}

fn do_extract_zip(zip_path: &std::path::Path, dest: &std::path::Path) -> io::Result<()> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
        let out_path = dest.join(entry.mangled_name());

        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut outfile = std::fs::File::create(&out_path)?;
            io::copy(&mut entry, &mut outfile)?;
        }
    }
    Ok(())
}

fn start_proxy(
    resource_dir: &std::path::Path,
    data_dir: &std::path::Path,
    backend_url: &str,
) -> Option<Child> {
    let proxy_exe = clean_path(&resource_dir.join(PROXY_EXE));
    let web_dir = clean_path(&data_dir.join("web"));

    if !proxy_exe.exists() {
        eprintln!("[tauri] {} not found at {:?}, skipping", PROXY_EXE, proxy_exe);
        return None;
    }

    if let Err(error) = ensure_proxy_port_available(data_dir, 3001) {
        eprintln!("[tauri] {}", error);
        return None;
    }

    println!("[tauri] Starting proxy: {:?}", proxy_exe);
    println!("[tauri]   WEB_DIR: {:?}", web_dir);

    let log_path = data_dir.join("proxy.log");
    let log_file = std::fs::File::create(&log_path).ok();
    let err_file = std::fs::File::create(data_dir.join("proxy-err.log")).ok();

    // Extract sharp.zip to data_dir/sharp/node_modules
    let sharp_zip = clean_path(&resource_dir.join("sharp.zip"));
    let sharp_dir = data_dir.join("sharp");
    let sharp_node_modules = clean_path(&sharp_dir.join("node_modules"));
    if sharp_zip.exists() {
        let sharp_marker = sharp_dir.join(".extracted");
        let needs_extract = if sharp_marker.exists() {
            let zip_mod = std::fs::metadata(&sharp_zip)
                .ok()
                .and_then(|m| m.modified().ok());
            let marker_mod = std::fs::metadata(&sharp_marker)
                .ok()
                .and_then(|m| m.modified().ok());
            match (zip_mod, marker_mod) {
                (Some(z), Some(m)) => z > m,
                _ => true,
            }
        } else {
            true
        };
        if needs_extract {
            println!("[tauri] Extracting sharp.zip to {:?}", sharp_dir);
            if sharp_dir.exists() {
                std::fs::remove_dir_all(&sharp_dir).ok();
            }
            std::fs::create_dir_all(&sharp_dir).ok();
            if let Err(e) = do_extract_zip(&sharp_zip, &sharp_dir) {
                eprintln!("[tauri] Failed to extract sharp.zip: {}", e);
            } else {
                std::fs::write(&sharp_marker, "ok").ok();
            }
        }
    }

    let mut cmd = Command::new(&proxy_exe);
    cmd.env("PROXY_PORT", "3001")
        .env("WEB_DIR", &path_str(&web_dir))
        .env("LOMO_BACKEND_URL", backend_url)
        .env("NODE_PATH", &path_str(&sharp_node_modules))
        .env("CONFIG_PATH", &path_str(&config_path(data_dir)));
    configure_background_child(&mut cmd);

    if let Some(f) = log_file {
        cmd.stdout(f);
    }
    if let Some(f) = err_file {
        cmd.stderr(f);
    }

    match cmd.spawn() {
        Ok(mut child) => {
            std::thread::sleep(std::time::Duration::from_millis(250));
            match child.try_wait() {
                Ok(Some(status)) => {
                    clear_proxy_pid(data_dir);
                    eprintln!("[tauri] proxy exited immediately with status {}", status);
                    None
                }
                Ok(None) => {
                    write_proxy_pid(data_dir, child.id());
                    println!("[tauri] proxy started (pid {})", child.id());
                    Some(child)
                }
                Err(e) => {
                    clear_proxy_pid(data_dir);
                    eprintln!("[tauri] Failed to inspect proxy process state: {}", e);
                    None
                }
            }
        }
        Err(e) => {
            clear_proxy_pid(data_dir);
            eprintln!("[tauri] Failed to start proxy: {}", e);
            None
        }
    }
}

/// Stops the lomod this app started (never Lomoagent's: that one is not our child).
fn kill_lomod(state: &mut AppState) {
    if let Some(ref mut p) = state.lomod_process {
        println!("[tauri] Killing lomod (pid {})", p.id());
        p.kill().ok();
        p.wait().ok();
        std::fs::remove_file(lomod_pid_path(&state.data_dir)).ok();
    }
    state.lomod_process = None;
}

fn kill_processes(state: &mut AppState) {
    kill_lomod(state);
    if let Some(ref mut p) = state.proxy_process {
        println!("[tauri] Killing proxy (pid {})", p.id());
        p.kill().ok();
        p.wait().ok();
    }
    state.proxy_process = None;
    clear_proxy_pid(&state.data_dir);
}

fn restart_proxy(state: &mut AppState, backend_url: &str) {
    let resource_dir = state.resource_dir.clone();
    let data_dir = state.data_dir.clone();

    if let Some(ref mut p) = state.proxy_process {
        println!("[tauri] Restarting proxy (pid {})", p.id());
        p.kill().ok();
        p.wait().ok();
    }
    clear_proxy_pid(&data_dir);

    state.proxy_process = start_proxy(&resource_dir, &data_dir, backend_url);
    std::thread::sleep(std::time::Duration::from_millis(500));
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

fn confirm_quit() -> bool {
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Warning)
        .set_title("Quit lomorage?")
        .set_description("This will stop the local photo viewer service and backend.")
        .set_buttons(rfd::MessageButtons::YesNo)
        .show()
        == rfd::MessageDialogResult::Yes
}

fn quit_from_tray(app: &tauri::AppHandle) {
    if !confirm_quit() {
        return;
    }

    if let Some(state) = app.try_state::<Mutex<AppState>>() {
        let mut state = state.lock().unwrap();
        kill_processes(&mut state);
        lid_power::restore_lid_action(&state.data_dir);
    }

    app.exit(0);
}

/// Tray menu; when this PC is the backup server (`local_server`), it leads with a
/// disabled hint that sleep pauses phone backups and the lid-closed backup toggle.
fn build_tray_menu<R: tauri::Runtime, M: Manager<R>>(
    manager: &M,
    local_server: bool,
) -> tauri::Result<Menu<R>> {
    let show_app = MenuItem::with_id(manager, TRAY_SHOW_APP_ID, "Show App", true, None::<&str>)?;
    let quit = MenuItem::with_id(manager, TRAY_QUIT_ID, "Quit", true, None::<&str>)?;
    if !local_server {
        return Menu::with_items(manager, &[&show_app, &quit]);
    }

    let sleep_hint = MenuItem::with_id(
        manager,
        TRAY_SLEEP_HINT_ID,
        backup_watch::SLEEP_HINT,
        false,
        None::<&str>,
    )?;
    let lid_backup = CheckMenuItem::with_id(
        manager,
        TRAY_LID_BACKUP_ID,
        backup_watch::LID_BACKUP_LABEL,
        true,
        backup_watch::LID_BACKUP_ENABLED.load(std::sync::atomic::Ordering::Relaxed),
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(manager)?;
    Menu::with_items(
        manager,
        &[&sleep_hint, &lid_backup, &separator, &show_app, &quit],
    )
}

fn create_tray_icon(app: &mut tauri::App) -> tauri::Result<TrayIcon> {
    let menu = build_tray_menu(app, false)?;

    let tray_icon = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .icon(TRAY_ICON)
        .tooltip("lomorage")
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_SHOW_APP_ID => show_main_window(app),
            TRAY_QUIT_ID => quit_from_tray(app),
            TRAY_LID_BACKUP_ID => backup_watch::toggle_lid_backup(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main_window(tray.app_handle()),
            _ => {}
        })
        .build(app)?;
    tray_icon.set_visible(true)?;
    Ok(tray_icon)
}

/// Make a simple HTTP POST request using raw TCP (no external deps).
fn http_post(host: &str, port: u16, path: &str, body: &str) -> io::Result<u16> {
    use std::io::Write;
    use std::net::TcpStream;

    let mut stream = TcpStream::connect((host, port))?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .ok();

    let request = format!(
        "POST {} HTTP/1.1\r\nHost: {}:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        path, host, port, body.len(), body
    );
    stream.write_all(request.as_bytes())?;

    let mut response = String::new();
    stream.read_to_string(&mut response).ok();

    if let Some(line) = response.lines().next() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 2 {
            if let Ok(code) = parts[1].parse::<u16>() {
                return Ok(code);
            }
        }
    }
    Ok(0)
}

/// Replicates LomoUtils.ts argon2 credential derivation so the stored credential
/// matches what the proxy sends at login time.
///
/// Flow (must stay in sync with hashPasswordForLomo in proxy/routes/auth.ts):
///   1. argon2id(password, salt=username+"@lomorage.lomoware", t=3, m=4096, p=1, len=32)
///   2. Build PHC string: $argon2id$v=19$m=4096,t=3,p=1$<saltB64>$<hashB64>
///   3. hex-encode every byte of that string (no zero-padding; all PHC chars are >= 0x20)
///   4. append "00"
fn hash_password_for_lomo(password: &str, username: &str) -> Result<String, String> {
    use argon2::{Algorithm, Argon2, Params, Version};
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let salt = format!("{}@lomorage.lomoware", username);
    let params = Params::new(4096, 3, 1, Some(32)).map_err(|e| format!("argon2 params: {}", e))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut hash = [0u8; 32];
    argon2
        .hash_password_into(password.as_bytes(), salt.as_bytes(), &mut hash)
        .map_err(|e| format!("argon2 hash: {}", e))?;

    let salt_b64 = STANDARD.encode(salt.as_bytes());
    let salt_b64 = salt_b64.trim_end_matches('=');
    let hash_b64 = STANDARD.encode(&hash);
    let hash_b64 = hash_b64.trim_end_matches('=');
    let encoded = format!("$argon2id$v=19$m=4096,t=3,p=1${}${}", salt_b64, hash_b64);

    let hex: String = encoded.bytes().map(|b| format!("{:x}", b)).collect();
    Ok(format!("{}00", hex))
}

fn create_admin_user(password: &str, home_dir: &std::path::Path) -> Result<(), String> {
    let credential = hash_password_for_lomo(password, "admin")?;
    std::fs::create_dir_all(&home_dir).ok();

    let body = serde_json::json!({
        "Name": "admin",
        "Password": credential,
        "HomeDir": path_str(&home_dir).replace('\\', "/"),
    })
    .to_string();

    println!("[tauri] Creating admin user...");

    for attempt in 1..=5 {
        std::thread::sleep(std::time::Duration::from_secs(1));
        match http_post("127.0.0.1", 8000, "/user", &body) {
            Ok(200) | Ok(201) => {
                println!("[tauri] Admin user created successfully");
                return Ok(());
            }
            Ok(code) if code >= 400 => {
                return Err(format!("Failed to create admin user (HTTP {})", code));
            }
            Ok(code) => {
                println!("[tauri] Create admin attempt {}: HTTP {}", attempt, code);
            }
            Err(e) => {
                println!("[tauri] Create admin attempt {}: {}", attempt, e);
            }
        }
    }
    Err("Could not create admin user after 5 attempts".into())
}

fn wait_for_local_users(data_dir: &std::path::Path, attempts: usize, delay_ms: u64) -> bool {
    for _ in 0..attempts {
        match local_user_exists(data_dir) {
            Ok(true) => return true,
            Ok(false) => {}
            Err(error) => {
                eprintln!("[tauri] Waiting for runtime assets.db failed: {}", error);
            }
        }

        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
    }

    false
}

// ── Tauri IPC Commands ──────────────────────────────────────────────

#[tauri::command]
fn get_app_settings(state: tauri::State<'_, Mutex<AppState>>) -> Result<serde_json::Value, String> {
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(app_settings_json(&state.data_dir))
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only http(s) URLs are allowed".into());
    }
    open_default_browser(&url).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_initial_setup_state(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<serde_json::Value, String> {
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(app_settings_json(&state.data_dir))
}

#[tauri::command]
fn show_welcome_page(app: tauri::AppHandle) -> Result<(), String> {
    // Navigate the main window to the welcome wizard (served by the proxy).
    // Works in both Tauri and plain-browser contexts — no separate popup.
    if let Some(main) = app.get_webview_window("main") {
        let url = "http://localhost:3001/lomo-welcome"
            .parse::<tauri::Url>()
            .map_err(|e| e.to_string())?;
        let _ = main.navigate(url);
        let _ = main.show();
        let _ = main.set_focus();
    }
    Ok(())
}

#[tauri::command]
fn save_backend_preference(
    state: tauri::State<'_, Mutex<AppState>>,
    backend_mode: String,
    remote_lomod_url: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    let data_dir = state.data_dir.clone();
    let resource_dir = state.resource_dir.clone();
    let next_mode = parse_backend_mode(&backend_mode)?;

    let mut config = get_app_config(&data_dir);
    config.active_backend_mode = next_mode.clone();
    if let Some(url) = remote_lomod_url {
        config.remote.default_url = normalize_remote_lomod_url(&url);
    }

    save_config(&data_dir, &config)?;

    // Start lomod if switching to local and it isn't running; never kill it. With Lomoagent, its lomod.
    if let Some(agent) = agent_backend(&config) {
        lomoagent::ensure_running(&agent, LOMOD_PORT, Duration::from_secs(30));
    } else if next_mode == BackendMode::Local && state.lomod_process.is_none() {
        let photos_dir = resolved_local_photos_dir(&data_dir, &config);
        state.lomod_process = start_lomod(&resource_dir, &data_dir, &photos_dir);
    }

    restart_proxy(&mut state, &backend_url_from_config(&config));

    Ok(app_settings_json(&data_dir))
}

#[tauri::command]
fn pick_folder() -> Result<Option<String>, String> {
    let result = rfd::FileDialog::new()
        .set_title("Choose a folder to store your photos")
        .pick_folder();
    Ok(result.map(|p| path_str(&p)))
}

#[tauri::command]
fn inspect_local_library_folder(
    state: tauri::State<'_, Mutex<AppState>>,
    photos_dir: String,
) -> Result<serde_json::Value, String> {
    let state = state.lock().map_err(|e| e.to_string())?;
    let trimmed = photos_dir.trim();
    let photos_path = PathBuf::from(trimmed);
    let folder_matches = if trimmed.is_empty() {
        Vec::new()
    } else {
        local_library_assets_db_paths(&photos_path)
    };
    let db_candidates = if trimmed.is_empty() {
        local_library_db_candidates(&state.data_dir, &default_photos_dir(&state.data_dir))
    } else {
        local_library_db_candidates(&state.data_dir, &photos_path)
    };
    // Folder-scoped: only a library that physically lives in the selected folder blocks
    // creating a new library there. Global/runtime DBs remain available to adopt below.
    let has_existing_user_db = db_candidates
        .iter()
        .any(|candidate| candidate.in_selected_folder && candidate.user_count > 0);

    Ok(serde_json::json!({
        "photos_dir": if trimmed.is_empty() { String::new() } else { path_str(&photos_path) },
        "has_existing_user_db": has_existing_user_db,
        "existing_assets_db_paths": folder_matches.iter().map(|path| path_str(path)).collect::<Vec<_>>(),
        "existing_library_databases": db_candidates,
    }))
}

#[tauri::command]
fn complete_initial_setup(
    state: tauri::State<'_, Mutex<AppState>>,
    photos_dir: String,
    password: String,
) -> Result<(), String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    let data_dir = state.data_dir.clone();
    let resource_dir = state.resource_dir.clone();

    let config = get_app_config(&data_dir);
    if config.active_backend_mode != BackendMode::Local {
        return Err("Switch to the bundled local backend before running desktop setup".into());
    }
    if let Some(agent) = agent_backend(&config) {
        return Err(agent_backend_message(&agent));
    }

    if is_initial_setup_complete(&data_dir) {
        return Err("Initial setup has already been completed".into());
    }

    let next_dir = photos_dir.trim();
    let next_password = password.trim();
    if next_dir.is_empty() {
        return Err("Photos directory is required".into());
    }
    if next_password.is_empty() {
        return Err("Password is required".into());
    }

    let previous_photos_dir = get_photos_dir(&data_dir);
    let photos_path = PathBuf::from(next_dir);
    let existing_library_db_paths = local_library_assets_db_paths(&photos_path);
    if !existing_library_db_paths.is_empty() {
        return Err(format!(
            "Selected folder already contains local library data at {}. Choose another folder or continue with the existing library sign-in flow.",
            path_str(&existing_library_db_paths[0])
        ));
    }

    std::fs::create_dir_all(&photos_path)
        .map_err(|e| format!("Failed to create directory: {}", e))?;
    let home_dir = clean_path(&photos_path.join("admin"));
    std::fs::create_dir_all(&home_dir)
        .map_err(|e| format!("Failed to create admin directory: {}", e))?;

    kill_lomod(&mut state);
    state.lomod_process = start_lomod(&resource_dir, &data_dir, &photos_path);

    if state.lomod_process.is_none() {
        state.lomod_process = start_lomod(&resource_dir, &data_dir, &previous_photos_dir);
        return Err("Failed to restart the Lomo backend".into());
    }

    if let Err(error) = create_admin_user(next_password, &home_dir) {
        kill_lomod(&mut state);
        state.lomod_process = start_lomod(&resource_dir, &data_dir, &previous_photos_dir);
        return Err(error);
    }

    let config = AppConfig {
        active_backend_mode: BackendMode::Local,
        local: LocalBackendConfig {
            photos_dir: path_str(&photos_path),
            setup_completed: true,
        },
        remote: config.remote,
        ..Default::default()
    };
    save_config(&data_dir, &config)?;
    println!(
        "[tauri] Initial setup completed: photos_dir={}",
        config.local.photos_dir
    );
    Ok(())
}

#[tauri::command]
fn use_existing_local_library(
    state: tauri::State<'_, Mutex<AppState>>,
    photos_dir: String,
    db_path: Option<String>,
    user_name: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    let data_dir = state.data_dir.clone();
    let resource_dir = state.resource_dir.clone();
    let previous_config = get_app_config(&data_dir);
    let previous_photos_dir = get_photos_dir(&data_dir);

    let next_dir = photos_dir.trim();
    if next_dir.is_empty() {
        return Err("Photos directory is required".into());
    }

    let photos_path = PathBuf::from(next_dir);
    let candidate_paths = local_library_db_paths(&data_dir, &photos_path);
    if candidate_paths.is_empty() {
        return Err("No existing assets.db files were found".into());
    }

    let selected_db_path = match db_path
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        Some(value) => {
            let requested = clean_path(&PathBuf::from(value));
            candidate_paths
                .iter()
                .find(|path| path_matches(path, &requested))
                .cloned()
                .ok_or_else(|| {
                    format!(
                        "Selected database is not one of the detected local libraries: {}",
                        value
                    )
                })?
        }
        None => candidate_paths
            .iter()
            .find(|path| !local_library_db_users(path).unwrap_or_default().is_empty())
            .cloned()
            .ok_or_else(|| "No local users were found in detected assets.db files".to_string())?,
    };

    let selected_user = selected_local_library_user(&selected_db_path, user_name.as_deref())?;
    let selected_photos_path =
        photos_dir_from_home_dir(&selected_user.home_dir).unwrap_or(photos_path);

    // Lomoagent's library, or one of its copies (it keeps one in each user's folder): use Lomoagent's running
    // lomod and its database as they are. Copying the database for a lomod of our own is what made two
    // databases hand out the same ids and the phones upload photos twice.
    if let Some(agent) = lomoagent::installation() {
        if !is_agent_library(&agent, &selected_db_path) {
            return Err(agent_backend_message(&agent));
        }
        let mut config = previous_config.clone();
        config.active_backend_mode = BackendMode::Local;
        config.local.photos_dir = path_str(&selected_photos_path);
        config.local.setup_completed = true;
        save_config(&data_dir, &config)?;
        kill_lomod(&mut state); // a lomod of our own, if one was running
        if !lomoagent::ensure_running(&agent, LOMOD_PORT, Duration::from_secs(90)) {
            return Err("Lomoagent's backend did not start. Start Lomoagent and try again.".into());
        }
        restart_proxy(&mut state, &backend_url_from_config(&config));
        println!(
            "[tauri] Using Lomoagent's library: db={} user={}",
            path_str(&agent.assets_db()),
            selected_user.user_name
        );
        return Ok(settings_with_selected_user(
            &data_dir,
            &selected_user,
            &clean_path(&agent.assets_db()),
        ));
    }

    let runtime_db_path = assets_db_path(&data_dir);
    let selected_is_runtime_db = path_matches(&selected_db_path, &runtime_db_path);

    kill_lomod(&mut state);

    let backup_dir = if selected_is_runtime_db {
        None
    } else {
        match backup_runtime_data_dir(&data_dir) {
            Ok(backup_dir) => backup_dir,
            Err(error) => {
                if previous_config.active_backend_mode == BackendMode::Local {
                    state.lomod_process =
                        start_lomod(&resource_dir, &data_dir, &previous_photos_dir);
                }
                return Err(error);
            }
        }
    };

    if let Err(error) = copy_assets_db_snapshot(&selected_db_path, &runtime_db_path) {
        restore_runtime_data_dir(&data_dir, backup_dir.as_deref()).ok();
        if previous_config.active_backend_mode == BackendMode::Local {
            state.lomod_process = start_lomod(&resource_dir, &data_dir, &previous_photos_dir);
        }
        return Err(error);
    }

    let mut config = previous_config.clone();
    config.active_backend_mode = BackendMode::Local;
    config.local.photos_dir = path_str(&selected_photos_path);
    config.local.setup_completed = true;

    if let Err(error) = save_config(&data_dir, &config) {
        restore_runtime_data_dir(&data_dir, backup_dir.as_deref()).ok();
        if previous_config.active_backend_mode == BackendMode::Local {
            state.lomod_process = start_lomod(&resource_dir, &data_dir, &previous_photos_dir);
        }
        return Err(error);
    }

    state.lomod_process = start_lomod(&resource_dir, &data_dir, &selected_photos_path);
    if state.lomod_process.is_none() {
        restore_runtime_data_dir(&data_dir, backup_dir.as_deref()).ok();
        save_config(&data_dir, &previous_config).ok();
        if previous_config.active_backend_mode == BackendMode::Local {
            state.lomod_process = start_lomod(&resource_dir, &data_dir, &previous_photos_dir);
        }
        return Err("Failed to restart the Lomo backend".into());
    }

    if !wait_for_local_users(&data_dir, 24, 250) {
        kill_lomod(&mut state);
        restore_runtime_data_dir(&data_dir, backup_dir.as_deref()).ok();
        save_config(&data_dir, &previous_config).ok();
        if previous_config.active_backend_mode == BackendMode::Local {
            state.lomod_process = start_lomod(&resource_dir, &data_dir, &previous_photos_dir);
        }
        return Err(
            "Existing library data was found, but lomod did not load any local users from it."
                .into(),
        );
    }

    save_config(&data_dir, &config)?;
    restart_proxy(&mut state, &backend_url_from_config(&config));

    println!(
        "[tauri] Existing local library loaded: db={} user={} photos_dir={}",
        path_str(&selected_db_path),
        selected_user.user_name,
        config.local.photos_dir
    );

    Ok(settings_with_selected_user(
        &data_dir,
        &selected_user,
        &selected_db_path,
    ))
}

fn settings_with_selected_user(
    data_dir: &std::path::Path,
    user: &LocalLibraryDbUser,
    db_path: &std::path::Path,
) -> serde_json::Value {
    let mut settings = app_settings_json(data_dir);
    if let Some(object) = settings.as_object_mut() {
        object.insert(
            "selected_local_user".into(),
            serde_json::json!({
                "user_name": user.user_name,
                "home_dir": user.home_dir,
                "db_path": path_str(db_path),
            }),
        );
    }
    settings
}

#[tauri::command]
fn create_new_local_library(
    state: tauri::State<'_, Mutex<AppState>>,
    photos_dir: String,
    password: String,
) -> Result<serde_json::Value, String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    let data_dir = state.data_dir.clone();
    let resource_dir = state.resource_dir.clone();
    let previous_config = get_app_config(&data_dir);
    let previous_photos_dir = get_photos_dir(&data_dir);

    if previous_config.active_backend_mode != BackendMode::Local {
        return Err("Switch to the bundled local backend before creating a local library".into());
    }
    if let Some(agent) = agent_backend(&previous_config) {
        return Err(agent_backend_message(&agent));
    }

    let next_dir = photos_dir.trim();
    let next_password = password.trim();
    if next_dir.is_empty() {
        return Err("Photos directory is required".into());
    }
    if next_password.is_empty() {
        return Err("Password is required".into());
    }

    let photos_path = PathBuf::from(next_dir);
    let existing_library_db_paths = local_library_assets_db_paths(&photos_path);
    if !existing_library_db_paths.is_empty() {
        return Err(format!(
            "Selected folder already contains local library data at {}. Open the existing library instead, or choose an empty folder.",
            path_str(&existing_library_db_paths[0])
        ));
    }

    std::fs::create_dir_all(&photos_path)
        .map_err(|e| format!("Failed to create directory: {}", e))?;
    let home_dir = clean_path(&photos_path.join("admin"));
    std::fs::create_dir_all(&home_dir)
        .map_err(|e| format!("Failed to create admin directory: {}", e))?;

    kill_lomod(&mut state);
    let backup_dir = match backup_runtime_data_dir(&data_dir) {
        Ok(backup_dir) => backup_dir,
        Err(error) => {
            state.lomod_process = start_lomod(&resource_dir, &data_dir, &previous_photos_dir);
            return Err(error);
        }
    };

    state.lomod_process = start_lomod(&resource_dir, &data_dir, &photos_path);
    if state.lomod_process.is_none() {
        restore_runtime_data_dir(&data_dir, backup_dir.as_deref()).ok();
        state.lomod_process = start_lomod(&resource_dir, &data_dir, &previous_photos_dir);
        return Err("Failed to restart the Lomo backend".into());
    }

    if let Err(error) = create_admin_user(next_password, &home_dir) {
        kill_lomod(&mut state);
        restore_runtime_data_dir(&data_dir, backup_dir.as_deref()).ok();
        state.lomod_process = start_lomod(&resource_dir, &data_dir, &previous_photos_dir);
        return Err(error);
    }

    let mut config = previous_config.clone();
    config.active_backend_mode = BackendMode::Local;
    config.local.photos_dir = path_str(&photos_path);
    config.local.setup_completed = true;
    if let Err(error) = save_config(&data_dir, &config) {
        kill_lomod(&mut state);
        restore_runtime_data_dir(&data_dir, backup_dir.as_deref()).ok();
        state.lomod_process = start_lomod(&resource_dir, &data_dir, &previous_photos_dir);
        return Err(error);
    }

    restart_proxy(&mut state, &backend_url_from_config(&config));
    if let Some(backup_dir) = backup_dir {
        println!(
            "[tauri] Previous local backend data preserved at {}",
            backup_dir.display()
        );
    }
    println!(
        "[tauri] New local library created: photos_dir={}",
        config.local.photos_dir
    );

    Ok(app_settings_json(&data_dir))
}

#[tauri::command]
fn save_app_settings(
    state: tauri::State<'_, Mutex<AppState>>,
    photos_dir: String,
    backend_mode: String,
    remote_lomod_url: String,
) -> Result<serde_json::Value, String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    let data_dir = state.data_dir.clone();
    let resource_dir = state.resource_dir.clone();
    let previous_photos_dir = get_photos_dir(&data_dir);
    let previous_config = get_app_config(&data_dir);
    let next_mode = parse_backend_mode(&backend_mode)?;
    let normalized_remote = normalize_remote_lomod_url(&remote_lomod_url);

    let mut config = previous_config.clone();
    config.active_backend_mode = next_mode.clone();
    config.remote.default_url = normalized_remote;

    match next_mode {
        BackendMode::Remote => {
            save_config(&data_dir, &config)?;
            kill_lomod(&mut state);
            restart_proxy(&mut state, &backend_url_from_config(&config));
            println!("[tauri] Settings saved: backend_mode=remote");
        }
        BackendMode::Local => {
            if let Some(agent) = lomoagent::installation() {
                // The backend and its folder are Lomoagent's: only switching (back) to it is done here.
                save_config(&data_dir, &config)?; // local now: the library below is Lomoagent's
                let library_dir = resolved_local_photos_dir(&data_dir, &config);
                let requested = photos_dir.trim();
                if !requested.is_empty() && !same_dir(&PathBuf::from(requested), &library_dir) {
                    save_config(&data_dir, &previous_config).ok();
                    return Err(agent_backend_message(&agent));
                }
                config.local.photos_dir = path_str(&library_dir);
                config.local.setup_completed = true;
                save_config(&data_dir, &config)?;
                kill_lomod(&mut state); // a lomod of our own, if one was running
                lomoagent::ensure_running(&agent, LOMOD_PORT, Duration::from_secs(30));
                restart_proxy(&mut state, &backend_url_from_config(&config));
                println!("[tauri] Settings saved: backend_mode=local (Lomoagent's backend)");
                return Ok(app_settings_json(&data_dir));
            }

            let next_dir = photos_dir.trim();
            if next_dir.is_empty() {
                return Err("Photos directory is required for the bundled local backend".into());
            }

            let photos_path = PathBuf::from(next_dir);
            std::fs::create_dir_all(&photos_path)
                .map_err(|e| format!("Failed to create directory: {}", e))?;

            kill_lomod(&mut state);

            if is_initial_setup_complete(&data_dir) {
                let home_dir = clean_path(&photos_path.join("admin"));
                std::fs::create_dir_all(&home_dir)
                    .map_err(|e| format!("Failed to create admin directory: {}", e))?;

                let admin_home_dir_updated = match update_admin_home_dir(&data_dir, &home_dir) {
                    Ok(updated) => updated,
                    Err(error) => {
                        state.lomod_process =
                            start_lomod(&resource_dir, &data_dir, &previous_photos_dir);
                        return Err(error);
                    }
                };

                if !admin_home_dir_updated {
                    state.lomod_process =
                        start_lomod(&resource_dir, &data_dir, &previous_photos_dir);
                    return Err(
                        "Admin user not found. Complete setup before changing the storage folder."
                            .into(),
                    );
                }

                println!("[tauri] Admin user HomeDir updated in local database");
            }

            config.local.photos_dir = path_str(&photos_path);
            if is_initial_setup_complete(&data_dir) {
                config.local.setup_completed = true;
            }
            save_config(&data_dir, &config)?;

            state.lomod_process = start_lomod(&resource_dir, &data_dir, &photos_path);
            restart_proxy(&mut state, &backend_url_from_config(&config));
            println!(
                "[tauri] Settings saved: backend_mode=local photos_dir={}",
                config.local.photos_dir
            );
        }
    }

    Ok(app_settings_json(&data_dir))
}

// ── Main ────────────────────────────────────────────────────────────

/// Bump this whenever a change alters the bytes the proxy serves for an image URL
/// (e.g. the HEIC full-resolution decode fix). The WebView marks image responses
/// `Cache-Control: immutable`, so previously-cached low-res previews would otherwise
/// be served forever. Changing this value triggers a one-time HTTP-cache purge.
const WEBVIEW_CACHE_SCHEMA: &str = "2-heic-fullres";

/// Purge the WebView2 HTTP cache once, when WEBVIEW_CACHE_SCHEMA changes.
///
/// Runs at the very start of `main()` — before Tauri creates the webview window —
/// so the cache files are not yet locked by the WebView2 process. Only the HTTP/
/// code/GPU caches are removed; cookies and session live under `Default/Network`
/// and are preserved so the user stays signed in.
fn purge_webview_cache_if_schema_changed() {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let app_local = PathBuf::from(local).join("com.lomoware.photoviewer");
    let webview = app_local.join("EBWebView");
    if !webview.exists() {
        return; // fresh install — nothing cached yet
    }

    let marker = app_local.join(".webview-cache-schema");
    if std::fs::read_to_string(&marker)
        .map(|v| v.trim() == WEBVIEW_CACHE_SCHEMA)
        .unwrap_or(false)
    {
        return; // already current
    }

    let profile = webview.join("Default");
    for sub in ["Cache", "Code Cache", "GPUCache"] {
        let dir = profile.join(sub);
        if dir.exists() {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
    let _ = std::fs::write(&marker, WEBVIEW_CACHE_SCHEMA);
    println!(
        "[tauri] Purged WebView HTTP cache (schema {})",
        WEBVIEW_CACHE_SCHEMA
    );
}

fn main() {
    purge_webview_cache_if_schema_changed();
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            get_app_settings,
            open_external_url,
            get_initial_setup_state,
            show_welcome_page,
            save_backend_preference,
            pick_folder,
            inspect_local_library_folder,
            complete_initial_setup,
            use_existing_local_library,
            create_new_local_library,
            save_app_settings,
        ])
        .setup(|app| {
            let resource_dir = app
                .path()
                .resource_dir()
                .expect("Failed to get resource dir");
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data dir");

            let tray_icon = create_tray_icon(app)?;
            app.manage(TrayState {
                _tray_icon: tray_icon,
            });

            create_main_window(app);
            create_startup_window(app);
            backup_watch::spawn(app.handle().clone());

            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(error) = run_startup(app_handle.clone(), resource_dir, data_dir) {
                    eprintln!("[tauri] Startup failed: {}", error);
                    update_startup_progress(
                        &app_handle,
                        100,
                        &format!("Startup failed: {}", error),
                    );
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if window.label() == "main" {
                    let _ = window.hide();
                }
            }
            tauri::WindowEvent::Destroyed => {
                if window.label() != "main" {
                    return;
                }

                if let Some(state) = window.app_handle().try_state::<Mutex<AppState>>() {
                    let mut state = state.lock().unwrap();
                    kill_processes(&mut state);
                    lid_power::restore_lid_action(&state.data_dir);
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}
