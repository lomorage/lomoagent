# Lomo Business Plan

## Executive Summary

LomoAgent can use an "open-source core + paid services + first-party mobile app" business model. The desktop application can remain open source, while the Immich-derived web UI is used only as the photo viewing experience layer and must comply with AGPLv3 source disclosure obligations. Commercial revenue should come primarily from the first-party mobile app, cloud backup and sync services, managed deployment, technical support, and advanced operations features.

The key licensing conclusion is: if the mobile app is developed independently by the Lomo team and does not copy, link, or embed AGPL code from Immich mobile or Immich web, it does not automatically become AGPL just because it calls Lomo APIs or connects to the desktop service. Therefore, the mobile app can be sold, offered as a subscription product, or distributed as closed source. However, the modified Immich Web portion included in the desktop product must still provide corresponding source code.

## Product Architecture And Open-Source Boundaries

The Lomo product can be separated into three clear parts:

- Desktop app: A Tauri application that starts local services, manages configuration, wraps the web UI, and acts as the main photo management entry point.
- Display layer: A modified Immich Web frontend used for photo browsing, timeline, albums, settings, and basic interactions.
- Mobile app: A first-party Lomo mobile client focused on photo and video backup, sync status, remote connection, and mobile-assisted workflows.

Immich should be treated as the foundation for the display experience, not as Lomo's closed-source commercial core. Lomo's differentiated value should come from backup experience, local desktop integration, mobile upload, cloud services, family/team deployment, and a low-friction user experience.

To reduce licensing risk, the product and code boundaries should stay explicit:

- Publish the source code, modification history, and build process for the Immich-derived Web layer.
- Keep the Lomo-owned desktop shell, proxy, and backend adapter open source if that remains the project strategy; the exact license can be chosen by the project.
- Keep the Lomo mobile app isolated from Immich code, without copying Immich mobile/web implementation, UI components, icons, text, or AGPL SDK code.
- Avoid product names and app store descriptions that imply the app is the official Immich app.

## License And Compliance Strategy

Immich currently uses GNU AGPLv3. If Lomo modifies and distributes Immich Web, it must satisfy AGPL obligations for source disclosure, copyright notices, license notices, and source availability for network interaction.

Recommended compliance strategy:

- Provide a clear Source Code link on the release page, README, About page, or Support page.
- The Source Code link must point to the exact source corresponding to the released version, including the Immich fork commit, Lomo modifications, build scripts, and dependency information.
- The root license should not simply claim that the entire project is MIT. It should clearly state which parts are Lomo-owned code and which parts are Immich-derived AGPL code.
- Provide a `NOTICE` or `THIRD_PARTY_LICENSES` document covering Immich, Tauri, Node/Rust dependencies, Sharp/native DLLs, ffmpeg/libvips, and other third-party components.
- If LAN or mobile users can access the modified Immich-derived service through a browser or phone, the UI should provide a clear source-code access point.

The mobile app can use a separate licensing strategy. As long as it is fully developed by Lomo and does not include Immich AGPL code, it can be distributed as:

- A closed-source paid app.
- A free app with a paid subscription service.
- An open-source app with paid premium cloud services.
- A one-time purchase app with optional cloud backup subscription.

## Business Model

### Paid Mobile App

The mobile app is the most direct paid entry point. It can provide automatic backup, background upload, LAN discovery, remote connection, upload queue management, retry handling, album selection, cellular network policy, and device storage management.

Pricing options:

- One-time purchase: Suitable for individual users and reduces subscription resistance.
- Free download + Pro unlock: Suitable for growing the user base.
- Family subscription: Supports multiple devices, multiple users, family sharing, and remote access.
- Business/team edition: Supports centralized deployment, policy management, and premium support.

### Cloud Backup And Sync Services

Cloud services can become a long-term revenue stream, but they must be clearly separated from the Immich-derived open-source display layer. Paid features can include:

- Remote access relay.
- Incremental cloud backup.
- Multi-device sync.
- Off-site disaster recovery.
- Encrypted backup storage.
- High-speed upload channel.

### Managed Hosting And Enterprise Deployment

For home NAS users, small teams, photography studios, and small businesses, Lomo can offer managed editions or deployment services:

- One-click deployment and initialization.
- Private cloud, NAS, or Windows host installation.
- Data migration service.
- Backup policy configuration.
- Permission and user management.
- SLA and troubleshooting support.

### Technical Support And Advanced Operations

Open-source software can be free to use while professional support is paid:

- Priority support.
- Remote diagnostics.
- Data recovery consulting.
- Version upgrade assistance.
- Enterprise security configuration.
- Custom feature development.

### Auto-Update And Value-Added Features

The desktop core can remain open source, while value-added features can be built around service experience:

- Auto-update channel.
- Backup health checks.
- Storage space alerts.
- Upload failure diagnostics.
- Multi-device sync status dashboard.
- Family member device management.

## Mobile App Monetization Feasibility

A first-party mobile app can be paid or closed source as long as it does not contain Immich AGPL code. Calling Lomo APIs, uploading files to Lomo services, or connecting to the desktop proxy does not by itself cause the mobile app to inherit AGPL.

Required boundaries:

- Do not copy Immich mobile source code, architecture implementation, or UI code.
- Do not embed Immich Web directly into the mobile app.
- Do not use official Immich branding, trademarks, or icons in a way that causes confusion.
- Do not transfer or hide the AGPL source obligations of the Immich-derived Web layer.
- If the app opens an Immich-derived Web page served by the Lomo desktop app, that page should still provide a source-code link.

The clean positioning is: the mobile app is Lomo's backup client, and the Immich-derived Web UI is the desktop display layer. Users pay for Lomo's first-party backup experience, mobile convenience, and cloud services, not for a closed-source resale of Immich's open-source display layer.

## Go-to-Market

The first phase should focus on individual and family users:

- Value proposition: Windows desktop photo library, local-first storage, automatic mobile backup, and no complex server setup.
- Channels: GitHub, official website, Microsoft Store, App Store, Google Play, NAS/self-hosting communities.
- Pricing: Free open-source desktop app, low-cost paid mobile app, or Pro unlock.

The second phase can expand to power users and small teams:

- Value proposition: Multi-device backup, remote access, cloud disaster recovery, and family sharing.
- Pricing: Subscription service or family plan.
- Support: Paid technical support and deployment assistance.

The third phase can target business and professional scenarios:

- Value proposition: Private deployment, data control, batch device backup, and dedicated support.
- Pricing: Deployment fee + annual support fee + optional cloud services.
- Delivery: Enterprise installer, deployment documentation, SLA, and custom integration.

## Risk Register

Highest risks:

- Building a public product from a private Immich fork without publishing the corresponding source code.
- Modifying Immich Web and releasing only installers without rebuildable source.
- Labeling the entire product as MIT while ignoring the Immich-derived AGPL portion.
- Copying Immich mobile code into the mobile app and then charging for it as closed source.

Medium risks:

- Hiding or removing Immich support/purchase entry points without clearly stating that this is an AGPL-based modified version of Immich.
- Release source links that do not match the actual released commit.
- Missing license notices for third-party binary dependencies.
- App store descriptions that use the Immich name in a confusing way.

Low-risk path:

- Keep the desktop app and Immich-derived Web layer open source.
- Attach clear source links and license notices to each release.
- Keep the mobile app fully first-party and position it as a Lomo backup client.
- Concentrate monetization on the first-party app, cloud services, managed deployment, and technical support.

## Next Steps

Recommended execution order:

1. Complete license documentation: add `NOTICE` or `THIRD_PARTY_LICENSES` to define the license boundaries for Lomo-owned code, Immich-derived code, and third-party dependencies.
2. Fix the release source strategy: ensure every release can be traced to the corresponding Immich fork commit and complete rebuildable source.
3. Add a Source Code link to the desktop About or Support page to satisfy source availability expectations for AGPL distribution and network interaction scenarios.
4. Define the mobile app technical boundary: confirm it is fully first-party and does not reuse Immich mobile/web code.
5. Design the mobile app MVP: prioritize login, device pairing, background backup, upload queue, retry handling, and LAN/remote connection.
6. Design pricing: start with a low-friction model, such as free desktop app + paid mobile Pro + optional cloud backup subscription.
7. Prepare app store materials: emphasize Lomo's first-party backup capability and avoid official Immich branding language that could confuse users.

Overall recommendation: Lomo can remain open source and still commercialize. The safest path is to publish all Immich-derived parts and build revenue around the first-party Lomo mobile app, cloud services, managed deployment, and professional support.
