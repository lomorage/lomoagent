//! Lomoagent on this computer: the Windows tray app that ships and runs its own lomod.
//!
//! When Lomoagent is installed, the phones back up to *its* lomod (port 8000), whose database is
//! `%LOCALAPPDATA%\lomoware\var\assets.db`. The viewer must use that same backend and database. It must not kill
//! it and start a second lomod with a copy of the database: two databases on one photo folder hand out the same
//! asset ids to different photos, and a phone that reaches the second one uploads again what the first one already
//! has (seen on a real library: 1,341 ids given twice, a few hundred photos stored twice).
//!
//! Only `installation()` differs by platform; Lomoagent exists on Windows only.

use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

pub struct Installation {
    /// lomoagent.exe, which starts lomod and restarts it when it stops (it checks every minute)
    pub agent_exe: PathBuf,
    /// the --base Lomoagent gives lomod; the database is var\assets.db in it
    pub base_dir: PathBuf,
}

impl Installation {
    pub fn assets_db(&self) -> PathBuf {
        self.base_dir.join("var").join("assets.db")
    }
}

#[cfg(target_os = "windows")]
pub fn installation() -> Option<Installation> {
    let local = PathBuf::from(std::env::var_os("LOCALAPPDATA")?);
    let agent_exe = local
        .join("Lomoware")
        .join("Lomoagent")
        .join("lomoagent.exe");
    if !agent_exe.is_file() {
        return None;
    }
    Some(Installation {
        agent_exe,
        base_dir: local.join("lomoware"),
    })
}

#[cfg(not(target_os = "windows"))]
pub fn installation() -> Option<Installation> {
    None
}

/// Something answers on 127.0.0.1:port (a lomod: nothing else of ours uses that port).
pub fn port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

#[cfg(target_os = "windows")]
fn agent_process_running() -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let Ok(out) = Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq lomoagent.exe", "/FO", "CSV", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    else {
        return false;
    };
    String::from_utf8_lossy(&out.stdout)
        .to_ascii_lowercase()
        .contains("lomoagent.exe")
}

#[cfg(not(target_os = "windows"))]
fn agent_process_running() -> bool {
    false
}

/// Makes sure Lomoagent's lomod answers on `port`: when it does not, starts lomoagent.exe if it is not running
/// (it then starts lomod) and waits up to `timeout`. Never starts a lomod itself. True when lomod answers.
pub fn ensure_running(install: &Installation, port: u16, timeout: Duration) -> bool {
    if port_open(port) {
        return true;
    }
    if !agent_process_running() {
        println!(
            "[tauri] Lomoagent is not running: starting {:?} (it starts lomod)",
            install.agent_exe
        );
        if let Err(e) = Command::new(&install.agent_exe).spawn() {
            eprintln!("[tauri] Failed to start Lomoagent: {}", e);
            return false;
        }
    }
    let start = Instant::now();
    while start.elapsed() < timeout {
        if port_open(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    eprintln!(
        "[tauri] Lomoagent's lomod did not answer on port {} within {:?}",
        port, timeout
    );
    false
}
