# Mobile QR Upload For LomoAgent

## Summary

Add a **Upload from phone** button inside the existing **Account** section of User Settings. Clicking it opens a QR-code modal. The phone scans the QR, opens a lightweight mobile upload page, logs in with Lomo credentials, then uploads selected photos/videos through the desktop proxy to the app's **currently configured backend**: bundled local `lomod` or remote Lomo server.

Using `show-ue-before-go`, the UX will be reviewed before implementation and kept scoped to this QR upload flow.

## UX Mockup

```text
Desktop: User Settings > Account
+--------------------------------------------+
| Account                                    |
| Manage your account                        |
|                                            |
| [existing profile/account controls]        |
|                                            |
| Upload from phone                          |
| Scan a QR code to upload mobile photos     |
| [ QR Upload ]                              |
+--------------------------------------------+

Click QR Upload
+--------------------------------------------+
| Upload from phone                          |
| Backend: Current backend                   |
|                                            |
|              [ QR CODE ]                   |
|                                            |
| http://192.168.x.x:3001/mobile-upload      |
| [copy link]                                |
+--------------------------------------------+

Mobile: /mobile-upload
+------------------------------+
| LomoAgent Upload     |
| Username                     |
| Password                     |
| [Sign in]                    |
|                              |
| [Select photos/videos]       |
| file1.jpg      72%           |
| file2.mov      uploaded      |
+------------------------------+
```

## Key Changes

- Add a new account-setting component/button in `submodules/immich/web/src/lib/components/user-settings-page/user-settings-list.svelte`, placed inside the existing `account` accordion below the profile settings.
- Reuse the existing QR rendering pattern from `QrCodeModal.svelte`, but create a purpose-specific modal that shows backend context, QR code, copyable URL, loading state, and error state.
- Add a public Svelte route at `/mobile-upload` outside the authenticated `(user)` route group, so phones can open it before login.
- Implement the mobile page as a small standalone upload UI: username/password login, multi-select `image/*,video/*`, per-file progress, duplicate/success/error states, and a retry action.

## API And Data Flow

- Add `GET /api/lomo/mobile-upload-link` in the proxy settings/stubs area.
- Require the desktop browser to already be authenticated for this endpoint via `getLomoToken(req)`.
- Return:

```ts
{
  url: string;          // e.g. http://192.168.1.25:3001/mobile-upload
  host: string;         // selected LAN IPv4 address
  port: number;         // 3001
  backendMode: 'local' | 'remote';
  backendUrl: string;   // current proxy backend target, for display only
}
```

- Resolve the QR host by choosing the first non-internal IPv4 LAN address from Node `os.networkInterfaces()`, falling back to the current request host if no LAN IP is found.
- Mobile login posts to the existing `POST /api/auth/login` without `x-lomo-server`; this uses the proxy's current `LOMO_BACKEND_URL`, which already reflects local or remote mode.
- Mobile upload posts each file to the existing `POST /api/assets` as `multipart/form-data` using the fields already expected by the proxy upload route: `assetData`, `deviceAssetId`, `deviceId`, `fileCreatedAt`, `fileModifiedAt`, `isFavorite`, and `duration`.
- No temporary QR token will be added because the selected behavior is **Mobile login**; the mobile browser must authenticate before upload.

## Implementation Details

- Make the proxy explicitly listen on `0.0.0.0` so phones on the same LAN can reach `:3001`; keep logs showing both localhost and selected LAN URL.
- Keep upload routing unchanged after authentication: the proxy forwards files to `auth.serverUrl`, so local uploads go to bundled `lomod`, and remote uploads go to the configured remote server.
- Use existing dependencies where possible: existing `qrcode` frontend package and existing `@immich/ui` modal/button primitives.
- Use MDI icons already used by the app, such as `mdiQrcode` or `mdiCellphoneArrowDownVariant`, for the account settings button.
- Mobile page should be intentionally minimal and not reuse the full Immich authenticated shell, to avoid redirect loops and desktop-only layout overhead.

## Test Plan

- `proxy`: test or manually verify `GET /api/lomo/mobile-upload-link` returns `401` when unauthenticated and a LAN URL when authenticated.
- `proxy`: verify `POST /api/auth/login` from the mobile page sets cookies and subsequent `POST /api/assets` succeeds.
- `frontend`: run Svelte/type checks for the new modal, account setting button, and `/mobile-upload` route.
- Desktop manual scenario: open User Settings, click **QR Upload**, confirm the QR modal displays a LAN URL and copy button.
- Mobile manual scenario: scan QR from a phone on the same Wi-Fi, log in, upload one photo and one video, confirm they appear in the desktop timeline.
- Remote manual scenario: switch to remote backend, regenerate QR, log in from phone, upload, and confirm files land on the remote server.
- Failure scenarios: wrong password, phone not on same network, no LAN IP detected, upload duplicate, upload failure, and mixed success/failure in a multi-file batch.

## Assumptions

- The QR upload page is only intended for devices on the same LAN as the desktop running the proxy.
- The phone user will know valid Lomo credentials for the current backend.
- The first version uploads directly into the normal Lomo asset flow, not into a chosen album.
- The QR URL targets the current configured backend through the desktop proxy; it does not let the phone choose local versus remote.
- Photos and videos are both allowed in the file picker and upload queue.
