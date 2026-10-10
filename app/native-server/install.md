# Chrome MCP Bridge Installation Guide

This document describes the installation and registration process for the Chrome MCP Bridge in detail.

## Installation Overview

Install from the release package (`chrome-mcp-package-*.zip` on the GitHub releases page), not from npm. The package bundles the bridge, so the only prerequisite is Node.js 20+.

```
unzip the package
└─ bash install.sh --yes        (macOS / Linux)
   install.cmd                  (Windows, double-click)
   ├─ Copies the bridge to ~/.chrome-mcp-agent
   ├─ Registers the Native Messaging host for your user (no sudo)
   └─ Prints the extension install steps and your client config
```

Then run `node show-config.js` for your MCP client's config and click **Connect** in the extension popup.

> **Do not run `npm install -g mcp-chrome-bridge`.** That is the upstream project, a different package. It overwrites this registration and the connection stops working after Chrome restarts.

The sections below describe what the installer does, for troubleshooting and manual registration.

## Detailed Installation Steps

### 1. Install

Run the installer from the unzipped package folder as shown above. Registration is automatic, user-level, and needs no administrator privileges.

### 2. User-Level Registration

User-level registration creates the manifest file in the following locations:

```
Manifest file location
├─ User level (no administrator privileges required)
│  ├─ Windows: %APPDATA%\Google\Chrome\NativeMessagingHosts\
│  ├─ macOS:   ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
│  └─ Linux:   ~/.config/google-chrome/NativeMessagingHosts/
│
└─ System level (administrator privileges required)
   ├─ Windows: %ProgramFiles%\Google\Chrome\NativeMessagingHosts\
   ├─ macOS:   /Library/Google/Chrome/NativeMessagingHosts/
   └─ Linux:   /etc/opt/chrome/native-messaging-hosts/
```

If automatic registration fails, or if you want to register manually, you can run:

```bash
node native-server/dist/cli.js register
```

**Recommended: run the diagnostic tool to check for problems:**

```bash
node native-server/dist/cli.js doctor
```

### 3. System-Level Registration

If user-level registration fails (for example, due to permission problems), you can try system-level registration. System-level registration requires administrator privileges, but we provide two convenient ways to complete it.

There are two ways to do system-level registration:

#### Option 1: Use the `--system` flag (recommended)

```bash
# macOS/Linux
sudo node native-server/dist/cli.js register --system

# Windows (run Command Prompt as Administrator)
node native-server/dist/cli.js register --system
```

System-level installation requires administrator privileges to write to system directories and the registry.

#### Option 2: Run directly with administrator privileges

**Windows**:
Run Command Prompt or PowerShell as Administrator, then execute:

```
node native-server/dist/cli.js register
```

**macOS/Linux**:
Use the sudo command:

```
sudo node native-server/dist/cli.js register
```

## Registration Process Explained

### Registration Flow Diagram

```
Registration flow
├─ User-level registration (node native-server/dist/cli.js register)
│  ├─ Get the user-level manifest path
│  ├─ Create the user directory
│  ├─ Generate the manifest content
│  ├─ Write the manifest file
│  └─ Windows: create a user-level registry entry
│
└─ System-level registration (node native-server/dist/cli.js register --system)
   ├─ Check whether administrator privileges are present
   │  ├─ Has privileges → create the system directory and write the manifest directly
   │  └─ No privileges → prompt the user to run with administrator privileges
   └─ Windows: create a system-level registry entry
```

### Manifest File Structure

```
manifest.json
├─ name: "com.chromemcp.nativehost"
├─ description: "Node.js Host for Browser Bridge Extension"
├─ path: "/path/to/run_host.sh"       ← startup script path
├─ type: "stdio"                      ← communication type
└─ allowed_origins: [                 ← extensions allowed to connect
   "chrome-extension://extensionID/"
]
```

### User-Level Registration Process

1. Determine the user-level manifest file path
2. Create the necessary directories
3. Generate the manifest content, including:
   - Host name
   - Description
   - Node.js executable path
   - Communication type (stdio)
   - Allowed extension IDs
   - Startup arguments
4. Write the manifest file
5. On Windows, also create the corresponding registry entry

### System-Level Registration Process

1. Detect whether administrator privileges are already present
2. If administrator privileges are present:
   - Create the system-level directory directly
   - Write the manifest file
   - Set appropriate permissions
   - On Windows, create a system-level registry entry
3. If administrator privileges are not present:
   - Prompt the user to re-run the command with administrator privileges
   - macOS/Linux: `sudo node native-server/dist/cli.js register --system`
   - Windows: run Command Prompt as Administrator

## Verifying the Installation

### Verification Flow Diagram

```
Verify installation
├─ Check the manifest file
│  ├─ File exists → check that the content is correct
│  └─ File does not exist → reinstall
│
├─ Check the Chrome extension
│  ├─ Extension installed → check extension permissions
│  └─ Extension not installed → install the extension
│
└─ Test the connection
   ├─ Connection succeeds → installation complete
   └─ Connection fails → check the error log → see Troubleshooting
```

### Verification Steps

After installation completes, you can verify success in the following ways:

1. Check that the manifest file exists in the appropriate directory
   - User level: check the manifest file in the user directory
   - System level: check the manifest file in the system directory
   - Confirm that the manifest file content is correct

2. Install the corresponding extension in Chrome
   - Make sure the extension is installed correctly
   - Make sure the extension has the `nativeMessaging` permission

3. Try connecting to the local service through the extension
   - Use the extension's test feature to attempt a connection
   - Check Chrome's extension logs for error messages

## Troubleshooting

### Troubleshooting Flow Diagram

```
Troubleshooting
├─ Permission problems
│  ├─ Check user permissions
│  │  ├─ Sufficient permissions → check directory permissions
│  │  └─ Insufficient permissions → try system-level installation
│  │
│  ├─ Execute-permission problems (macOS/Linux)
│  │  ├─ "Permission denied" error
│  │  ├─ "Native host has exited" error
│  │  └─ Run node native-server/dist/cli.js fix-permissions
│  │
│  └─ Try node native-server/dist/cli.js register --system
│
├─ Path problems
│  ├─ Check the Node.js install (node -v)
│  └─ Check the global NPM path (npm root -g)
│
├─ Registry problems (Windows)
│  ├─ Check registry access permissions
│  └─ Try creating the registry entry manually
│
└─ Other problems
   ├─ Check the console error messages
   └─ Submit an issue to the project repository
```

### Common Troubleshooting Steps

If you run into problems during installation, try the following steps:

1. Make sure Node.js is installed correctly
   - Run `node -v` and `npm -v` to check the versions
   - Make sure the Node.js version is >= 20.x

2. Check that you have sufficient permissions to create files and directories
   - User-level installation requires write access to the user directory
   - System-level installation requires administrator/root privileges

3. **Fix execute-permission problems**

   **macOS/Linux**:

   **Description**:
   - Unzipping with some tools drops the execute bit from the launcher scripts
   - You may encounter "Permission denied" or "Native host has exited" errors
   - The Chrome extension cannot start the native host process

   **Solutions**:

   a) **Use the built-in fix command (recommended)**:

   ```bash
   node native-server/dist/cli.js fix-permissions
   ```

   b) **Run the diagnostic tool to auto-fix**:

   ```bash
   node native-server/dist/cli.js doctor --fix
   ```

   c) **Set permissions manually**:

   ```bash
   # From the unzipped package folder
   chmod +x native-server/run_host.sh
   chmod +x native-server/dist/cli.js
   ```

   **Windows**:

   **Description**:
   - On Windows, `.bat` files usually don't need execute permissions, but you may hit other issues
   - Files may be marked as read-only
   - You may encounter "Access denied" or files that won't execute

   **Solutions**:

   a) **Use the built-in fix command (recommended)**:

   ```cmd
   node native-server/dist/cli.js fix-permissions
   ```

   b) **Run the diagnostic tool to auto-fix**:

   ```cmd
   node native-server/dist/cli.js doctor --fix
   ```

   c) **Check file attributes manually**:

   ```cmd
   # doctor prints the install path and the host manifest location
   node native-server/dist/cli.js doctor

   # Check file attributes (right-click -> Properties in File Explorer)
   # Make sure run_host.bat is not read-only
   ```

   d) **Reinstall and force permissions**:

   ```bash
   # Re-run the installer from the unzipped package folder
   bash install.sh --yes

   # If problems persist, run the permission fix
   node native-server/dist/cli.js fix-permissions
   ```

4. On Windows, make sure registry access is not restricted
   - Check that you can access `HKCU\Software\Google\Chrome\NativeMessagingHosts\`
   - For system level, check `HKLM\Software\Google\Chrome\NativeMessagingHosts\`

5. Try a system-level installation
   - Use the `node native-server/dist/cli.js register --system` command
   - Or run directly with administrator privileges

6. Check the error messages in the console output
   - Detailed error messages usually point to the problem
   - You can add the `--verbose` flag to get more log information

If the problem persists, please submit an issue to the project repository and include the following information:

- Operating system version
- Node.js version
- The install command
- The error message
- The solutions you have tried
