# Third-party notices

The repository does not commit third-party executables or model files. The optional runtime installer downloads pinned upstream artifacts into the user's local application-data directory and verifies their digests before use.

Each upstream component remains governed by its own license. The Project license does not replace those terms.

| Component | Pinned version | Upstream license or terms | Source |
| --- | --- | --- | --- |
| yt-dlp | `2026.07.04` | Unlicense; the standalone executable contains third-party components and notices | https://github.com/yt-dlp/yt-dlp |
| FFmpeg essentials build | `8.1.2` | GPL-3.0 as reported by the selected build; users and redistributors must comply with the corresponding FFmpeg/build terms | https://www.gyan.dev/ffmpeg/builds/ and https://ffmpeg.org/legal.html |
| whisper.cpp | `v1.9.2` | MIT | https://github.com/ggml-org/whisper.cpp |
| multilingual Whisper model | `small` | Upstream model and distribution terms apply | https://huggingface.co/ggerganov/whisper.cpp |
| wx_channel | `v5.7.1` | MIT | https://github.com/nobiyou/wx_channel |

Microsoft Edge or Google Chrome may be used when already installed on the user's computer. They are not distributed by this repository and remain subject to their vendors' terms.

The PolyForm Noncommercial License text in `LICENSE` comes from the PolyForm Project. The text is reproduced without modifying its standard terms; the Project adds only its permitted Required Notice.

If a runtime source, digest, license, or distribution method changes, update this file and `src/runtime-manager.mjs` in the same pull request.
