# PhasePad Build Instructions

## Prerequisites
- Node.js (Latest LTS version)
- Windows 10/11
- Code signing certificate (optional, for signed builds)

## Development Build
```bash
npm install
npm start
```

## Production Build

### Without Code Signing
```bash
npm run build
```

### With Code Signing
**IMPORTANT**: Never commit the certificate password to the repository!

1. Set the certificate password as an environment variable:
```bash
# Windows Command Prompt
set WINDOWS_CERTIFICATE_PASSWORD=your_password

# Windows PowerShell
$env:WINDOWS_CERTIFICATE_PASSWORD = "your_password"

# Git Bash / Linux / macOS
export WINDOWS_CERTIFICATE_PASSWORD=your_password
```

2. Run the build:
```bash
npm run build
```

The build process will automatically use the certificate password from the environment variable.

## Build Output
The installer will be created in the `dist` folder:
- `PhasePad-1.0.0-x64.exe` - Windows installer

## Security Notes
- The certificate file `phasepad-cert.pfx` should be kept secure
- Never commit the certificate password to any file in the repository
- The certificate password is only needed for signed builds
- Users can still install unsigned builds with a security warning

## GitHub Release Process
1. Ensure all changes are committed
2. Create a new tag:
```bash
git tag v1.0.0
git push origin v1.0.0
```

3. Build the signed installer (see above)

4. Create a GitHub release:
   - Go to https://github.com/OwenModsTW/phasepad/releases
   - Click "Create a new release"
   - Choose the tag you created
   - Upload the installer from the `dist` folder
   - Add release notes

## Troubleshooting

### Certificate Password Issues
If you get an error about the certificate password:
- Ensure the environment variable is set correctly
- Check that the password matches the one used when creating the certificate
- Try building without signing if you don't need code signing

### Build Failures
- Delete `node_modules` and run `npm install` again
- Delete the `dist` folder and try building again
- Check that all dependencies are installed correctly

### Missing Dependencies
If electron-builder is missing dependencies:
```bash
npm install --save-dev electron-builder
npm install @electron/remote electron-updater winreg
```