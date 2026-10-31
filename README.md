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

- **Characters** (card, picture, tags, favourite, linked lorebooks and new gallery items), **Chats** (messages,
  Author's Note and other chat settings, and the unsent draft), **Lorebooks**, **Personas** (names, descriptions,
  pronouns, pictures and bound lorebooks), **Prompt presets** (blocks and ordering), and **Playlists** (folders and
  character memberships).
- **Incremental** brings in what is new or changed. **Mirror** also removes what the other device does not have.
- **Exact** lets the device you sync from win. **Prefer newer** keeps this device's edit when its own clock says it
  is newer.

Each device's connections and settings stay its own.

## How it works

- Pairing: the QR code carries a one-time code, the device's addresses and its X25519 public key. The scanning device
  sends its own key, both derive the pair's secret by key agreement (the secret never crosses the network), and the
  six digits both screens show come from both keys, so a device standing in between would show different digits.
- Every later request between the two is signed with that secret (HMAC-SHA256 over method, path, time and body). A
  paired device can only read; "push" asks the other side to pull.
- A sync compares content digests (card plus picture, tags and flags, chat messages, lorebook entries), not
  timestamps, so a synced item reads as unchanged on the next pass. Characters keep their ids across devices; a card
  imported on both devices apart is recognised as the same character.
- New characters travel as Σ's own transfer bundles; changes go through Σ's public API (replace, PATCH, the chat
  message routes), so every write is guarded and shows up live in every open tab.

## Limits

- Needs a server without accounts (single user).
- Traffic between the two devices is plain HTTP, like Σ itself on your network. Requests are signed, but their
  content is not encrypted: sync on networks you trust, or over a VPN such as Tailscale.
- A chat's own pictures (attachments) do not travel yet; gallery sync only adds, never removes.
- Renaming a chat makes it a new chat to the other device.

## Tests

```
node --test test/plan.test.mjs test/http.test.mjs
node --test test/two-devices.test.mjs   # boots two real Σ servers; set SIGMA_DIR to your Σ checkout
```

Vendored: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT) and
[jsQR](https://github.com/cozmo/jsQR) (Apache-2.0, see `client/vendor/jsQR.LICENSE`).
