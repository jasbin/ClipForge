API_DIR := services/api
VENV := $(CURDIR)/.venv
PY := $(VENV)/bin/python
PYTHON312 ?= $(shell command -v python3.12)

.PHONY: setup dev api worker web find lint clean-data

setup:  ## create the project venv (.venv, Python 3.12) and install web deps
	@test -n "$(PYTHON312)" || (echo "python3.12 not found (brew install python@3.12)"; exit 1)
	@test -d "$(VENV)" || $(PYTHON312) -m venv "$(VENV)"
	"$(PY)" -m pip install -q --upgrade pip
	"$(PY)" -m pip install -q -e "$(API_DIR)[url,tts]"
	cd apps/web && npm install
	@test -f .env || cp .env.example .env

dev:  ## run API (:8000), worker and web (:3000) together; Ctrl-C stops all three
	@trap 'kill 0' INT TERM; \
	$(MAKE) --no-print-directory api & \
	$(MAKE) --no-print-directory worker & \
	$(MAKE) --no-print-directory web & \
	wait

api:
	cd $(API_DIR) && "$(VENV)/bin/uvicorn" clipforge.api:app --reload --port 8000

worker:
	cd $(API_DIR) && "$(PY)" -m clipforge.worker

web:
	cd apps/web && npm run dev

find:  ## make find VIDEO=path/to/video.mp4 [ARGS="--min 15 --max 30"]
	cd $(API_DIR) && "$(PY)" -m clipforge.find "$(abspath $(VIDEO))" $(ARGS)

lint:
	cd apps/web && npm run lint
	"$(PY)" -m compileall -q $(API_DIR)/clipforge

clean-data:  ## delete all projects, cached transcripts and the database
	rm -rf data
