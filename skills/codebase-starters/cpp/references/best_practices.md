# C++ Engineering Reference & Deep Best Practices

## 1. Modern CMake Target-Based Architecture
- Use `target_link_libraries`, `target_include_directories`, and `target_compile_options`.
- Never use global `include_directories()` or `link_libraries()`.

## 2. Sanitizers & Debugging
- Enable ASan and UBSan in Debug builds:
  `-fsanitize=address,undefined -fno-omit-frame-pointer`

## 3. ABI Compatibility & PImpl Pattern
- Use pointer-to-implementation (PImpl) when building dynamic library interfaces (`.so` / `.dll`) to maintain ABI stability across library upgrades.
