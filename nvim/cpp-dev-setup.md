1. clangd - Use mason to install clangd for language server in neovim

2. cmake - I used winget to install cmake

```winget install Kitware.CMake```

Check the version matches (or exceeds) whatever `cmake_minimum_required(VERSION ...)` says in the project's CMakeLists.txt.

3. LLVM - For the cpp compiler (clang/clang++), and also the debugger (lldb) + DAP adapter (lldb-dap.exe) used by nvim-dap

```https://github.com/llvm/llvm-project/releases/tag/llvmorg-22.1.8```

Add `C:\Program Files\LLVM\bin` to PATH so `clang++`, `lldb`, and `lldb-dap` are all reachable.

4. VS Build Tools - needed even though we compile with clang, because on Windows clang still links against the MSVC linker + Windows SDK libraries (ucrt, kernel32.lib, etc.), and `nmake` (used as the CMake build driver, see below) ships with it too

On this machine this came from Unity Hub - it installs its own VS Build Tools + "Desktop development with C++" workload the first time you create/open a project. If you don't have Unity, install it directly instead:

```winget install --id Microsoft.VisualStudio.2026.BuildTools```

Either way, make sure the "Desktop development with C++" workload is installed. Don't need to add it to PATH manually - CMake auto-detects it, and CMakePresets.json can point straight at the full path (see the `CMAKE_MAKE_PROGRAM` example below).

5. vcpkg - like npm for cpp, resolves and builds C++ package dependencies (e.g. SFML)

```
git clone https://github.com/microsoft/vcpkg C:\path\to\vcpkg
C:\path\to\vcpkg\bootstrap-vcpkg.bat
```

Then set a **persistent** `VCPKG_ROOT` user environment variable pointing at that clone (`setx VCPKG_ROOT "C:\path\to\vcpkg"`) - CMakePresets.json's toolchain file path (`$env{VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake`) depends on it. Requires a **new terminal/Neovim session** to pick up after setting it.

Install whatever library the project needs, e.g.:

```vcpkg install sfml```

6. Build generator - we're NOT using Ninja on this machine (never installed it). CMakePresets.json uses `"generator": "NMake Makefiles"`, reusing `nmake.exe` from the VS Build Tools install in step 4 as the build driver - no separate install needed. It still supports `compile_commands.json`, unlike the plain Visual Studio generator (which does NOT emit `compile_commands.json` and will break clangd).

If you'd rather use Ninja on a future machine, that's a valid alternative (`"generator": "Ninja"`), just requires installing it separately:

```winget install Ninja-build.Ninja```

7. clangd needs to actually find `compile_commands.json` - two things must be true in the project:
   - `CMAKE_EXPORT_COMPILE_COMMANDS ON` set in CMakeLists.txt (writes `build/compile_commands.json`)
   - a `.clangd` file in the project root pointing at it:
     ```
     CompileFlags:
       CompilationDatabase: build
     ```

8. nvim-dap (debugging in Neovim) - no separate install needed beyond what's above. `nvim-dap`/`nvim-dap-ui` install automatically via lazy.nvim on first Neovim launch, and are wired to `lldb-dap.exe` from step 3 directly (no codelldb or Mason package required for C++).
