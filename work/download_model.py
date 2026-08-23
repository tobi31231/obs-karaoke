import json
import sys
from pathlib import Path


MODEL_REPOSITORIES = {
    "turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "large-v3": "Systran/faster-whisper-large-v3",
    "medium": "Systran/faster-whisper-medium",
    "small": "Systran/faster-whisper-small",
}


def main():
    model_name = sys.argv[1] if len(sys.argv) > 1 else "turbo"
    repository = MODEL_REPOSITORIES.get(model_name, f"Systran/faster-whisper-{model_name}")
    target = Path(__file__).resolve().parents[1] / "models" / f"faster-whisper-{model_name}"
    target.mkdir(parents=True, exist_ok=True)

    from huggingface_hub import snapshot_download

    snapshot_download(
        repo_id=repository,
        local_dir=str(target),
        allow_patterns=["config.json", "model.bin", "tokenizer.json", "vocabulary.*", "preprocessor_config.json"]
    )

    from faster_whisper import WhisperModel

    WhisperModel(str(target), device="cpu", compute_type="int8")
    print(json.dumps({"ok": True, "model": model_name, "repository": repository, "path": str(target)}))


if __name__ == "__main__":
    main()
