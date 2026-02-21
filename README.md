# Kensar Print Agent Tray

Aplicacion de bandeja (tipo QZ Tray) para ejecutar el print-agent en segundo plano en Windows.

## Caracteristicas

- Corre en segundo plano sin ventana principal.
- Icono en system tray.
- Abre UI local en `http://127.0.0.1:5177/ui`.
- Auto inicio al iniciar sesion.
- API local para imprimir en `http://127.0.0.1:5177/print`.

## Desarrollo local

```bash
npm install
npm run dev
```

## Build Windows

```bash
npm install
npm run build:win
```

El instalador queda en `dist/`.

## Release automatico

Con tag `v*`, GitHub Actions compila y publica el instalador en Releases.
