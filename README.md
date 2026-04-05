# Wildlife & Sightings — Backend

This is the backend for the **Wildlife & Sightings Telegram Bot**, a Node.js/Express server that powers wildlife identification and bird sighting features delivered through a Telegram bot interface.

---

## Description

The backend provides a Telegram bot handler for identifying wildlife from photos and exploring real-time bird sighting data from around the world. It integrates with multiple external APIs — eBird, iNaturalist, GBIF, Wikipedia, and Google Gemini AI — to deliver rich identification results and location-aware sighting information. All query and sighting data is logged to Google Sheets for record-keeping.

> **Note:** This is only the initial part of the project. More features are still being developed and have not been added yet.

---

## Features

### 🐦 Bird Sightings (Interactive Menu)
- Search recent bird sightings by **region code**, **country**, **city**, or **coordinates**
- Search for **notable and rare sightings** in any location
- Find bird sightings **nearby** using a shared Telegram location
- Search for sightings of a **specific species** in any location worldwide
- Flexible **date range filters** — today, yesterday, last 3 days, last week, last 14 days, last month, or a custom date
- Browse results with **paginated inline navigation**
- Supports both **sub-region** (e.g. `SG-01`) and **coordinate-based** radius searches

### 🐾 Wildlife Identification
- Identify wildlife from a photo using **Google Gemini AI**
- Returns common name, scientific name, taxonomy, IUCN conservation status, sex, life stage, morph, migratory status, and breeding plumage
- Displays **eBird sighting count** for the species at the user's location
- Links to **eBird**, **iNaturalist**, and **Wikipedia** for further reading
- Generates a composite result image with a reference species photo and an info panel
- **Daily identification limits** to manage API usage (15/day for private chats, 20/day for groups), seeded from Google Sheets on restart

### ➕ Add Personal Sighting
- Log a personal bird sighting through a guided multi-step conversation
- Captures species, location, date, count, observation type, and notes
- Saves directly to **Google Sheets**
- Provides a direct **Submit to eBird** link on completion

### 📓 My Sightings Logs
- Retrieve and display personal sighting history from Google Sheets
- Paginated log browser within Telegram

### 🔢 Species Search
- Search for any bird species by name worldwide
- Confirms species with eBird taxonomy
- Follow up with a location search to find recent observations


