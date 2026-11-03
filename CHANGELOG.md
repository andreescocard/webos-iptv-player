# Changelog

## Unreleased

### Fixed

- Movie suggestions keep full-width artwork while backdrop details load,
  instead of briefly showing a side poster on each rotation.
- Movie suggestions resume their ten-second rotation after a temporary
  Continue Watching or catalog tile preview instead of stopping permanently.

## 1.20.0 — 2026-11-02

### Added

- Related movies and a Related Series button in series details.

### Changed

- Movie suggestions rotate.

### Fixed

- Series details preserve focus and refresh the resume rail.

## 1.19.0 — 2026-11-02

### Changed

- Search now covers channels, movies, and series without program indexing.
- Movies shows random suggestions rated at least 7/10 above the Watchlist
  and within each category, using the provider's available ratings.
- Movie categories have icons and remain accessible in small catalogs.
  Explicit service-labeled categories are grouped under Streaming.
- Movie category grids support original order, alphabetical order in both
  directions, and highest rating first, with unrated titles last.

### Fixed

- Category recommendations keep remote navigation within the action row
  and move down to sorting before the movie grid.
- Series still initializes the Continue Watching banner with the saved
  episode, including titles outside the preloaded categories.
- Movie category labels remain readable across all themes and at 150%
  text size.

## 1.18.0 — 2026-10-26

### Added

- Continue Watching cards show a progress bar.
- Focusing an episode in Continue Watching shows its series, episode, and
  still in the banner.

### Changed

- An episode counts as watched in its last 2 minutes, and Continue
  Watching moves on to the next one.
- Continue Watching keeps one card per series, and earlier episodes are
  marked watched.
- Episode cards show the series on one line and the episode on another,
  without repeating the series name.

### Fixed

- Progress is saved while you watch and when you leave the app, not
  only when you press Back.
- An episode that plays to the end, or fails during the credits, now
  counts as watched.

## 1.17.0 — 2026-10-26

### Added

- Continue Watching moves on to the next episode after you finish one.

### Changed

- Trailers skip uploads of the full movie and ask for HD.

### Fixed

- Movies and Series open on the title you watched last, not on the first
  one in the catalog.
- The Magic Remote can skip ads in trailers.

## 1.16.1 — 2026-10-19

### Added

- Movies and Series open on a large banner with rows of titles, episode
  stills, rating, translated genres, and a short synopsis.
- A Trailer button plays the trailer in the app. It finds the trailer on
  TMDB (optional key in Settings), then the provider's trailer, then a
  YouTube search.
- Trailers seek ±10 s and show "Trailer unavailable" when they can't
  play.
- New Cinema theme and a 4-column theme grid.
- Icons in the tab bar and a pulsing Live dot.

### Changed

- All Categories wraps into a grid with clearer tiles.
