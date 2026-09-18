@echo off
rem ULTRON LiveKit worker launcher (Windows cmd)
cd /d "%~dp0"
where uv >nul 2>nul || (echo uv is required - install from https://docs.astral.sh/uv/ & exit /b 1)
uv sync
uv run agent.py %1
