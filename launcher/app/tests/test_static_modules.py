"""Browser ES modules must be served with a JavaScript MIME type."""

import httpx
import pytest

from app import create_app


@pytest.mark.asyncio
async def test_browser_modules_are_served_as_javascript(app_context):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(app_context)), base_url="http://127.0.0.1") as client:
        for name in ("persistence", "presentation", "source-selection", "log-console", "launcher-session", "marker-mount-editor"):
            response = await client.get(f"/static/{name}.mjs")
            assert response.status_code == 200
            assert "javascript" in response.headers["content-type"]
