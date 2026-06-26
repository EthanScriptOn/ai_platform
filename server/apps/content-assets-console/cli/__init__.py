from _shared_path import extend_shared_path

extend_shared_path(__file__, __name__, __path__)

from .main import main

__all__ = ["main"]
