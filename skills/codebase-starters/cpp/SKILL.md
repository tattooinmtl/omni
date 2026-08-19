---
name: cpp
description: >-
  Production C++20/C++23 codebase starter, modern CMake, RAII, Smart Pointers, Sanitizers (ASan/TSan), Clang-Tidy, GoogleTest, and harness controls for C++.
---

# C++ Codebase & Engineering Skill

Comprehensive operational guide, starter architecture, best practices, and harness controls for C++ engineering.

## 1. Stack Overview & Dependencies
- **Standard Version**: C++20 / C++23 (`-std=c++20`)
- **Build System**: Modern CMake (3.25+) with `Ninja` or `Make`
- **Compilers**: GCC 13+, Clang 16+, MSVC 2022+
- **Core Dependencies**:
  - `fmt` / `std::format`: Fast string formatting
  - `nlohmann_json` / `simdjson`: JSON parsing
  - `spdlog`: High-performance logging
  - `gtest` (GoogleTest) / `Catch2`: Testing framework
  - `clang-tidy` & `clang-format`: Static analysis & code formatting
  - `ASan` / `UBSan` / `TSan`: Memory & thread sanitizers

## 2. Standard Codebase Structure
```text
cpp-project/
├── CMakeLists.txt
├── README.md
├── include/
│   └── app/
│       ├── Engine.hpp
│       └── Models.hpp
├── src/
│   ├── CMakeLists.txt
│   ├── Engine.cpp
│   └── main.cpp
└── tests/
    ├── CMakeLists.txt
    └── EngineTest.cpp
```

## 3. How-To Workflows

### Configure & Build
```bash
# Configure build with CMake Ninja generator
cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Debug -DENABLE_SANITIZERS=ON

# Build target
cmake --build build --config Debug
```

### Run Executable
```bash
./build/bin/app_main
```

### Static Analysis & Formatting
```bash
# Format code
clang-format -i include/app/*.hpp src/*.cpp tests/*.cpp

# Run clang-tidy
clang-tidy -p build src/main.cpp
```

### Testing & Verification
```bash
ctest --test-dir build --output-on-failure
```

## 4. Best Practices & Design Patterns
1. **RAII (Resource Acquisition Is Initialization)**: Manage all resources (memory, file descriptors, locks) via scope bound objects. Never call naked `new`/`delete`.
2. **Smart Pointers**: Use `std::unique_ptr` for exclusive ownership and `std::shared_ptr` / `std::weak_ptr` for shared ownership. Pass by reference or `std::string_view` / `std::span` to avoid copies.
3. **Const Correctness & Noexcept**: Mark non-modifying methods `const` and functions that don't throw `noexcept` for optimizer hints.
4. **Move Semantics & Rvalue References**: Implement `std::move` and pass heavy objects by value or rvalue reference (`T&&`).
5. **Modern Standard Algorithms**: Use `<algorithm>` (`std::ranges`, `std::transform`, `std::find_if`) instead of manual raw loops.

## 5. Tips, Tricks & Pitfalls
- **Dangling References**: Never return references or pointers to local stack variables.
- **Undefined Behavior (UB)**: Compile with `-Wall -Wextra -Werror -fsanitize=address,undefined` during development.
- **Header Guards / `#pragma once`**: Ensure all headers use `#pragma once` or standard include guards.

## 6. Harness Hooks & Safety Enforcement
- **PreToolUse Guard**: Block unsafe `cmake --build` configurations that omit error warnings in production.
- **PostToolUse Verification**: Run `clang-tidy` and `ctest` automatically on C++ file edits.
