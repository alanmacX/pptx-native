# Asset Search And Media

Use this when the deck needs real-world visuals or media and the user did not
provide files. Asset search is a sourcing workflow, not a style preset: it must
not impose layout, palette, typography, or repeated slide structure.

## Search Workflow

1. Decide the asset role first: hero photo, product image, texture, logo,
   diagram reference, video clip, audio clip, or generated bitmap.
2. Search/download with provenance:
   ```bash
   node tools/ppt_asset_search.cjs --query "query terms" --type image --download --out outputs/assets/<slug>
   node tools/ppt_asset_search.cjs --query "query terms" --type video --download --out outputs/assets/<slug>
   ```
3. Read `outputs/assets/<slug>/assets.json` and choose assets that fit the
   content. Prefer files with clear author/license/page URL metadata.
4. Embed local/data assets in the PPTX. Do not hotlink remote URLs in final decks.
5. Keep attribution available in speaker notes or an appendix when the license
   requires it.

Default source is Wikimedia Commons because it exposes license and author
metadata without API keys. For brands, logos, private products, or people, prefer
user-provided files or official pages instead of generic stock-like results.

## HTML Usage

Images:

```html
<img class="ppt-picture" src="file:///absolute/path/to/image.jpg"
  style="position:absolute;left:80px;top:80px;width:420px;height:280px">
```

Video:

```html
<video class="ppt-media" src="file:///absolute/path/to/clip.mp4"
  poster="file:///absolute/path/to/poster.jpg"
  style="position:absolute;left:120px;top:90px;width:720px;height:405px"></video>
```

Audio:

```html
<div class="ppt-media" data-media-type="audio"
  data-src="file:///absolute/path/to/audio.mp3"
  style="position:absolute;left:80px;top:540px;width:80px;height:80px"></div>
```

`data-ppt-anim`, `data-ppt-sequence`, `data-ppt-glow`, `data-ppt-blur`, and
`data-ppt-reflection` may target `.ppt-picture` and `.ppt-media`.

## Scene JSON Usage

```json
{
  "type": "media",
  "mediaType": "video",
  "src": "file:///absolute/path/to/clip.mp4",
  "poster": "file:///absolute/path/to/poster.jpg",
  "x": 120,
  "y": 90,
  "w": 720,
  "h": 405
}
```

Supported carriers:

- `type:"image"`: `data:image/*`, `file://`, or local path.
- `type:"media"`: `mediaType:"video|audio"`, `data:video/*`, `data:audio/*`,
  `file://`, or local path. Prefer MP4 for video and MP3/WAV/M4A for audio.

Remote HTTP(S) URLs are search/import inputs, not final authoring inputs.
Download them first so the PPTX is reproducible and self-contained.
