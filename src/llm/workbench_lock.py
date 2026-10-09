"""Private, nonblocking shared model slot for cooperating DSA processes."""
from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import stat


@contextmanager
def shared_model_slot():
    state = os.getenv('WORKBENCH_STATE_DIR')
    if not state:
        yield  # existing non-workbench callers keep their contract
        return
    directory = Path(state)
    if not directory.is_absolute() or any(p.is_symlink() for p in (directory, *directory.parents)):
        raise RuntimeError('Unsafe model lock directory')
    fd = os.open(directory / 'model-generation.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise RuntimeError('Unsafe model lock file')
        os.fchmod(fd, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)
