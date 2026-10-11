# Installing LomoAgent on Windows

## Option 1 — One-line PowerShell install (recommended)

Open **PowerShell** and run:

```powershell
irm https://github.com/lomorage/lomoagent/releases/latest/download/install.ps1 | iex
```

This will:
1. Fetch the latest release from GitHub
2. Download the installer automatically
3. Install silently (no prompts)
4. Launch LomoAgent when done

> **Note:** If your system blocks script execution, run PowerShell as Administrator or prepend the bypass flag:
> ```powershell
> powershell -ExecutionPolicy Bypass -Command "irm https://github.com/lomorage/lomoagent/releases/latest/download/install.ps1 | iex"
> ```

---

## Option 2 — Manual download

1. Go to the [latest release](https://github.com/lomorage/lomoagent/releases/latest)
2. Download `lomorage_*_x64-setup.exe`
3. Double-click the file and follow the prompts (or install silently with `lomorage_*_x64-setup.exe /S`)

---

## System requirements

| | |
|---|---|
| OS | Windows 10 / 11 (64-bit) |
| Architecture | x64 |
| Network | Local or remote Lomo backend |

---

## First run

On first launch the app will ask you to choose a storage mode:

- **This machine** — stores photos locally; bundled `lomod` runs on `localhost:8000`
- **Remote server** — connects to an existing Lomo backend on your network or in the cloud

Follow the on-screen setup to select a photos folder and create an admin password.

### Keep the computer awake for the first backup

In **This machine** mode, phones back up to this computer over Wi-Fi, so backups pause whenever it sleeps (closing a laptop lid, idle timeout, or choosing **Sleep**). Keep the computer on, plugged in, and awake — lid open — until the first large backup finishes.

While a phone is connected, the app keeps Windows from sleeping on its idle timer, and it shows a notification if the computer slept during a backup. The tray menu shows the same reminder.

On a laptop you can turn on **Keep backing up with the lid closed (plugged in)** in the tray menu. While a phone is backing up and the laptop is plugged in, closing the lid then won't put it to sleep; your usual lid setting comes back as soon as the backup finishes or you unplug. A computer that is actually asleep can't receive backups, so choosing **Sleep**, unplugging with the lid closed, or a low battery still pauses the backup.

---

## Uninstall

Open **Settings → Apps → Installed apps**, search for **lomorage**, and click **Uninstall**.
