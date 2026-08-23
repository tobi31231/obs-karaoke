import shutil
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path


ARCHIVES = [
    (
        "https://developer.download.nvidia.com/compute/cuda/redist/libcublas/windows-x86_64/"
        "libcublas-windows-x86_64-12.8.4.1-archive.zip",
        ("cublas64_12.dll", "cublasLt64_12.dll"),
        "cuBLAS-LICENSE.txt",
    ),
    (
        "https://developer.download.nvidia.com/compute/cudnn/redist/cudnn/windows-x86_64/"
        "cudnn-windows-x86_64-9.1.0.70_cuda12-archive.zip",
        ("cudnn*.dll",),
        "cuDNN-LICENSE.txt",
    ),
]


def matches(name, patterns):
    path = Path(name)
    if "bin" not in [part.lower() for part in path.parts]:
        return False
    return any(path.match(f"**/{pattern}") for pattern in patterns)


def download(url, target):
    print(f"Downloading {Path(url).name}...", flush=True)
    with urllib.request.urlopen(url, timeout=60) as response, target.open("wb") as output:
        shutil.copyfileobj(response, output, length=1024 * 1024)


def extract_archive(archive, patterns, runtime_bin, license_target):
    extracted = []
    with zipfile.ZipFile(archive) as bundle:
        names = bundle.namelist()
        for name in names:
            if not matches(name, patterns):
                continue
            destination = runtime_bin / Path(name).name
            with bundle.open(name) as source, destination.open("wb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
            extracted.append(destination.name)

        license_names = [
            name for name in names
            if Path(name).name.lower() in {"license.txt", "license", "license.md"}
        ]
        if license_names:
            with bundle.open(license_names[0]) as source, license_target.open("wb") as output:
                shutil.copyfileobj(source, output)

    if not extracted:
        raise RuntimeError(f"No runtime DLLs found in {archive.name}")
    return extracted


def main():
    if sys.platform != "win32":
        print("CUDA runtime bundling is only required on Windows.")
        return

    root = Path(__file__).resolve().parents[1]
    runtime = root / "runtime" / "cuda"
    runtime_bin = runtime / "bin"
    licenses = runtime / "licenses"
    runtime_bin.mkdir(parents=True, exist_ok=True)
    licenses.mkdir(parents=True, exist_ok=True)

    extracted = []
    with tempfile.TemporaryDirectory(prefix="obs-karaoke-cuda-") as temporary:
        temporary_path = Path(temporary)
        for index, (url, patterns, license_name) in enumerate(ARCHIVES):
            archive = temporary_path / f"runtime-{index}.zip"
            download(url, archive)
            extracted.extend(extract_archive(archive, patterns, runtime_bin, licenses / license_name))

    required = ["cublas64_12.dll", "cublasLt64_12.dll", "cudnn64_9.dll"]
    missing = [name for name in required if not (runtime_bin / name).exists()]
    if missing:
        raise RuntimeError(f"CUDA runtime is incomplete: {', '.join(missing)}")

    print(f"CUDA runtime ready: {len(extracted)} DLLs in {runtime_bin}")


if __name__ == "__main__":
    main()
