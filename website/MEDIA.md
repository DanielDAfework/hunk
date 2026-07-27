# Documentation media

The two workflow captures in `public/docs/images/` are optimized copies of the current product screenshots embedded in the repository README:

- `review-stream.webp` — `https://github.com/user-attachments/assets/35605618-be3f-479e-b6e0-edb089910651`
- `agent-comments.webp` — `https://github.com/user-attachments/assets/92eb8993-f044-436d-a038-8139da5ad8de`

They teach the full review stream and inline agent-note workflows rather than serving as decorative art. Refresh them when those workflows visibly change.

Image refresh is an optional, Unix-oriented maintainer task; website builds and tests do not invoke it. With ImageMagick installed, resize and strip metadata before committing:

```bash
magick source.png -resize '1400x>' -strip -quality 82 public/docs/images/review-stream.webp
magick source.png -resize '960x>' -strip -quality 82 public/docs/images/agent-comments.webp
```

`public/og.png` is the shared 1200×630 social card for the landing page and documentation. Keep it aligned with the site metadata and paper/green theme.

## Community video thumbnails

`public/video-*.webp` are self-hosted copies of the YouTube thumbnails for the walkthroughs listed in `src/components/marketing/CommunityVideos.astro`. Hosting them here keeps the landing page free of third-party requests, so refresh them by hand when a creator changes their thumbnail:

```bash
curl -sfL https://i.ytimg.com/vi/<video-id>/maxresdefault.jpg -o /tmp/thumb.jpg
magick /tmp/thumb.jpg -resize '900x>' -strip -quality 80 public/video-<channel>.webp
```

Durations in that component are hardcoded because they never change once a video is published. Verify them against the video before adding a new card.
