GO := GOTOOLCHAIN=go1.26.0 go

.PHONY: run build frontend check
run:
	$(GO) run main.go
frontend:
	npm run build
build: frontend
	$(GO) build -trimpath -o coastwise main.go
check:
	$(GO) vet ./...
	node --check frontend/src/main.js
