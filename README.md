# Rubber Soul ♠️♥️♦️♣️

A clean, stateless, and comprehensive rubber bridge scorer built with React Native (Expo) for Android/iOS and a single-file HTML version for the web.

Rubber Soul is designed to completely replace the traditional pen-and-paper tally for rubber bridge. It handles all the complex math of bridge scoring (trick points, overtricks, undertrick penalties, honors, and slam bonuses) while keeping your data 100% private and offline.

## ✨ Key Features

* **Complete Scoring Engine:** Automatically calculates vulnerable/non-vulnerable penalties, doubled/redoubled modifiers, and applies standard 500/700 point rubber bonuses.
* **History Vault:** Completed and paused rubbers are saved locally. You can name sessions (e.g., "Friday Night Bridge") and resume unfinished games at any time.
* **Serverless Cross-Device Sharing:** Transfer a live game to another device instantly via a compressed URL link. **No accounts, no cloud databases, and no servers required.**
* **Privacy-First:** Zero analytics, zero proprietary tracking SDKs, and no internet connection required to play.
* **Accessibility:** Fully annotated for screen readers (VoiceOver/TalkBack), with toggleable High Contrast and 4-Color Deck modes.

---

## 🏗️ Technical Architecture: The "Stateless Bridge"

To maintain strict privacy and offline capabilities, Rubber Soul does not use a backend database to share sessions between devices. Instead, it serializes the entire game state into the URL fragment (`#`). 

When a user taps "Share," the app:
1. Minifies the current game state, historical archive, and player names into a strict JSON array: `[protocol_version, names_array, archive_array, active_hands_array]`.
2. Compresses the array using **LZ-String** (Protocol v5) for maximum URI-safe density. (Note: The app maintains backward compatibility with older Protocol v4 Base64-encoded strings).
3. Generates a link pointing to the web-hosted version of the app (e.g., `https://eater.github.io/#...`).

When the link is opened on a new device, the app intercepts the URL, decompresses the hash, and seamlessly rebuilds the local state.

---

## 🛠️ Local Development

This project is built using [Expo](https://expo.dev/). 

### Prerequisites
* Node.js and npm installed.
* [Expo CLI](https://docs.expo.dev/more/expo-cli/) installed globally.

### Installation
1. Clone the repository:
   ```bash
   git clone [https://github.com/YOUR-USERNAME/rubbersoul.git](https://github.com/YOUR-USERNAME/rubbersoul.git)
   cd rubbersoul
