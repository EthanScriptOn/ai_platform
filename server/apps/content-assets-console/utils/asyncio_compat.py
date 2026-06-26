import asyncio
from functools import partial
from typing import Any, Callable


async def to_thread(func: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Any:
    native = getattr(asyncio, "to_thread", None)
    if native is not None:
        return await native(func, *args, **kwargs)
    loop = asyncio.get_running_loop()
    call = partial(func, *args, **kwargs)
    return await loop.run_in_executor(None, call)
