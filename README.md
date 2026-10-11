# Who's That?

A small phone web app for two everyday questions:

- **Why do I know that face?** Drop in a photo and get the closest match among public figures, plus about 10 famous people with similar faces.
- **Why do I recognize that name?** Type a name, even misspelled, and see everyone famous with that name plus people with similar-sounding names.

Every result shows what the person is known for, and hand-checked "often mistaken for" pairs (for example Will Ferrell and Chad Smith).

## Privacy
- Photos are analysed **in the browser, on the device**. They are never uploaded.
- The index contains only public figures who have an English Wikipedia article.
- Face fingerprints are built only from **free-licence photos on Wikimedia Commons**.

## How it's built
| Part | Source / tool | Licence |
|---|---|---|
| People, descriptions | Wikidata, English Wikipedia | CC0 / CC BY-SA |
| Photos | Wikimedia Commons | free licences, per file |
| Face detection | [YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) | MIT |
| Face fingerprints | [SFace](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface) | Apache-2.0 |
| Runtime | onnxruntime-web (WebAssembly) | MIT |
| Name sound-alikes | double-metaphone | MIT |

The GitHub Action **Build and publish** collects people, computes face fingerprints from Commons photos, runs an accuracy test and publishes the site to GitHub Pages.

This is a personal, non-commercial project.
