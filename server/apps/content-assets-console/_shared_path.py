from pathlib import Path


def extend_shared_path(package_file: str, package_name: str, package_path) -> None:
    app_root = _find_app_root(Path(package_file).resolve())
    shared_package_path = app_root.parent / "content-assets-shared" / package_name.replace(".", "/")
    if not shared_package_path.exists():
        return

    shared_path = str(shared_package_path)
    if shared_path not in package_path:
        package_path.insert(0, shared_path)


def _find_app_root(file_path: Path) -> Path:
    for parent in file_path.parents:
        if parent.name == "content-assets-console":
            return parent
    return file_path.parent
