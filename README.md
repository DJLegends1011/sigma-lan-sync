# LAN Sync for Project Σ

Keeps two Project Σ installs (say a phone and a desktop) in step over your network, after TauriTavern's LAN Sync:
pair them once by scanning a QR code, then pull or push characters, chats and lorebooks between them.

## Install

Settings > Extensions > Install from this repository's git URL (or copy this folder into
`extensions/installed/lan-sync/`), restart the server (LAN Sync has a server half), and switch it on. Do the same on
both devices. Each device needs to listen on the network: `host: 0.0.0.0` in `data/server.yaml` (the default).

## Use

1. On one device, open **LAN Sync** (More Options) and press **Show a Pairing Code**.
2. On the other, press **Scan a Code** and point the camera at it, or paste the link. A phone's own camera app works
   too: the code opens `localhost:7788`, which is the phone's own Σ.
3. Both screens show the same six digits. If they match, press **Allow** on the device that showed the code.
4. On either device, **Sync From It** pulls the other device's library into this one. **Send to It** asks the other
   device to pull from this one. **Check** shows what a sync would change, without changing anything.

What a sync carries, and how, is set in the panel:

- **Characters** (card, picture, tags, favourite, linked lorebooks, provider links and gallery items), **Chats**
  (messages, chat attachments/pictures, characterless chats, Author's Note and other chat settings, and the unsent
  draft), **Lorebooks** (worlds and global lorebook bindings), **Personas** (names, descriptions, pronouns, pictures,
  bound lorebooks and active persona), **Prompt presets** (blocks, ordering and active preset), **Playlists** (folders
  and character memberships), **Backgrounds** (chat wallpapers and bindings), and optionally **Connections** (LLM
  profiles and API keys — off by default).
- **Incremental** brings in what is new or changed. **Mirror** also removes what the other device does not have.
- **Exact** lets the device you sync from win. **Prefer newer** keeps this device's edit when its own clock says it
  is newer.

## How it works

- Pairing: the QR code carries a one-time code, the device's addresses and its X25519 public key. The scanning device
  sends its own key, both derive the pair's secret by key agreement (the secret never crosses the network), and the
  six digits both screens show come from both keys, so a device standing in between would show different digits.
- Every later request between the two is signed with that secret (HMAC-SHA256 over method, path, time and body). A
  paired device can only read; "push" asks the other side to pull.
- Direct SQLite Database + Media Sync: instead of crawling hundreds of HTTP endpoints, the source device creates an
  atomic SQLite snapshot (`VACUUM INTO`) and strips local-only state (`change_log`, `x_lan_sync_*`, and `llm_profiles`
  unless Connections sync is enabled). The receiving device attaches the snapshot (`ATTACH DATABASE ... AS remote`) and
  merges all selected tables inside a single native SQLite transaction while SQLite triggers maintain FTS5 search
  indexes and counters automatically, then streams any new or changed media files (`avatars`, `gallery`, `personas`,
  `attachments`, `backgrounds`).

## Limits

- Needs a server without accounts (single user).
- Traffic between the two devices is plain HTTP, like Σ itself on your network. Requests are signed, but their
  content is not encrypted: sync on networks you trust, or over a VPN such as Tailscale.

## Tests

```
node --test test/plan.test.mjs test/http.test.mjs
node --test test/two-devices.test.mjs   # boots two real Σ servers; set SIGMA_DIR to your Σ checkout
```

Vendored: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT) and
[jsQR](https://github.com/cozmo/jsQR) (Apache-2.0, see `client/vendor/jsQR.LICENSE`).
