---
name: cpp-coding
command: /cpp
description: C/C++ environment setup, syntax rules, best practices, and project scaffolding.
---

# C/C++ Coding Skill

## Purpose
Guide the user through C/C++ environment detection, installation, project scaffolding, modern C++20/C++23 syntax, and best practices.

## When to use
Use this skill when the user runs:

/cpp [subcommand]

Subcommands:
- (none) — Detect C/C++ environment, report status, and offer to fix issues
- new <project-name> — Scaffold a new C/C++ project
- check — Scan current project for issues
- help — Show this help

---

## Phase 1 — Environment Detection & Installation

### Step 1: Detect existing installation
Use `run_shell` to check:
```powershell
where gcc
gcc --version
where g++
g++ --version
where clang
clang --version
where cl          # MSVC
where cmake
cmake --version
where make
where ninja
```

### Step 2: Report status
- ✅ / ❌ C compiler (gcc/clang/msvc)
- ✅ / ❌ C++ compiler (g++/clang++/msvc)
- ✅ / ❌ CMake (build system)
- ✅ / ❌ Make or Ninja (build runner)

### Step 3: Install if missing

**Windows:**
```powershell
# Option A: MinGW-w64 (GCC for Windows)
winget install MartinStorsjo.LLVM-MinGW.UCRT

# Option B: Visual Studio Build Tools (MSVC)
winget install Microsoft.VisualStudio.2022.BuildTools
# Select "Desktop development with C++" workload

# Option C: LLVM/Clang
winget install LLVM.LLVM

# CMake
winget install Kitware.CMake

# Ninja (faster build runner)
winget install Ninja-build.Ninja
```

**Linux:**
```bash
sudo apt install build-essential cmake ninja-build
# For Clang:
sudo apt install clang clang-tools
```

**macOS:**
```bash
xcode-select --install
brew install cmake ninja llvm
```

### Step 4: Verify
```powershell
g++ --version
cmake --version
```

---

## Phase 2 — Project Scaffolding

### CMake project structure
```
my_project/
├── CMakeLists.txt
├── src/
│   ├── main.cpp
│   ├── utils/
│   │   ├── CMakeLists.txt
│   │   ├── utils.cpp
│   │   └── utils.hpp
│   └── core/
│       ├── CMakeLists.txt
│       ├── core.cpp
│       └── core.hpp
├── tests/
│   ├── CMakeLists.txt
│   └── test_main.cpp
├── include/
│   └── my_project/
│       └── public_api.h
└── README.md
```

### Root CMakeLists.txt
```cmake
cmake_minimum_required(VERSION 3.20)
project(my_project VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(BUILD_TESTING "Build tests" ON)

add_subdirectory(src)

if(BUILD_TESTING)
    enable_testing()
    add_subdirectory(tests)
endif()
```

### Create project
```powershell
mkdir my_project
cd my_project
# Create CMakeLists.txt and source files
cmake -B build -G Ninja
cmake --build build
./build/src/my_project
```

---

## Phase 3 — Syntax Rules & Best Practices

### Modern C++ (C++20/C++23)

#### Use `auto` for type deduction
```cpp
// ✅ Use auto when type is obvious
auto result = compute_value();
auto& ref = container[key];
const auto& cref = get_data();

// ✅ Use structured bindings (C++17)
for (const auto& [key, value] : my_map) {
    std::cout << key << ": " << value << "\n";
}
```

#### Use smart pointers — never raw `new`/`delete`
```cpp
#include <memory>

// ✅ Unique ownership
auto ptr = std::make_unique<Widget>(args...);

// ✅ Shared ownership
auto shared = std::make_shared<Widget>(args...);

// ❌ Never use raw new/delete
Widget* w = new Widget();  // Memory leak risk
delete w;
```

#### Use `std::span` instead of `const std::vector&` (C++20)
```cpp
#include <span>

// ✅ Accept any contiguous container
void process(std::span<const int> data) {
    for (auto x : data) { /* ... */ }
}

// Works with vector, array, C-array
std::vector<int> v = {1, 2, 3};
int arr[] = {4, 5, 6};
process(v);
process(arr);
```

#### Use `std::format` (C++20) or `std::print` (C++23)
```cpp
#include <format>
#include <print>

// C++20
std::string s = std::format("Hello, {}! You are {} years old.", name, age);

// C++23
std::println("Hello, {}!", name);
```

#### Use `constexpr` and `consteval`
```cpp
// Compile-time computation
constexpr int factorial(int n) {
    return (n <= 1) ? 1 : n * factorial(n - 1);
}
static_assert(factorial(5) == 120);

// Immediate function (C++20) — must run at compile time
consteval int square(int x) { return x * x; }
constexpr int s = square(5);  // OK
// int s2 = square(get_input()); // Error — not constexpr
```

#### Use concepts (C++20)
```cpp
// Define a concept
template<typename T>
concept Numeric = std::integral<T> || std::floating_point<T>;

// Use as constraint
template<Numeric T>
T add(T a, T b) { return a + b; }

// Abbreviated function template
auto multiply(Numeric auto a, Numeric auto b) { return a * b; }
```

#### Use ranges (C++20)
```cpp
#include <ranges>
#include <algorithm>

auto evens = vec
    | std::views::filter([](int x) { return x % 2 == 0; })
    | std::views::transform([](int x) { return x * 2; });

for (auto x : evens) {
    std::cout << x << " ";
}
```

#### Use `std::expected` for error handling (C++23)
```cpp
#include <expected>

std::expected<int, std::string> parse_int(std::string_view s) {
    try {
        return std::stoi(std::string(s));
    } catch (const std::exception& e) {
        return std::unexpected(std::string("Parse error: ") + e.what());
    }
}

auto result = parse_int("42");
if (result) {
    std::println("Value: {}", *result);
} else {
    std::println("Error: {}", result.error());
}
```

### Naming Conventions
- **Types and classes**: `PascalCase` or `snake_case` (match project convention)
- **Functions and variables**: `snake_case` (common in C++) or `camelCase`
- **Constants**: `SCREAMING_SNAKE_CASE` or `kPascalCase`
- **Member variables**: `m_` prefix or trailing `_` (e.g., `m_count` or `count_`)
- **Template parameters**: `PascalCase` (e.g., `typename InputIterator`)
- **Namespaces**: `snake_case` (e.g., `my_project::core`)

### RAII (Resource Acquisition Is Initialization)
- **Always use RAII** — resources are acquired in constructors and released in destructors
- **Use smart pointers** — not manual memory management
- **Use `std::lock_guard` / `std::scoped_lock`** for mutexes
- **Use `std::fstream`** — automatically closes on destruction

```cpp
// ✅ RAII — lock automatically released
{
    std::scoped_lock lock(mutex);
    shared_data.push_back(item);
}  // lock released here

// ✅ RAII — file automatically closed
{
    std::ifstream file("data.txt");
    if (!file) return;
    std::string line;
    while (std::getline(file, line)) {
        process(line);
    }
}  // file closed here
```

### Const Correctness
- **Use `const` everywhere** — variables, parameters, methods
- **Mark member functions `const`** if they don't modify state
- **Use `constexpr`** for compile-time constants
- **Use `[[nodiscard]]`** for return values that shouldn't be ignored

```cpp
class Container {
public:
    [[nodiscard]] size_t size() const noexcept { return data_.size(); }
    [[nodiscard]] const auto& at(size_t i) const { return data_.at(i); }
    void push_back(int value) { data_.push_back(value); }

private:
    std::vector<int> data_;
};
```

### Error Handling
- **Use exceptions for exceptional cases** — not for control flow
- **Use `std::expected` (C++23)** for recoverable errors
- **Use assertions** (`assert`) for programming errors
- **Use `noexcept`** for functions that don't throw

```cpp
// noexcept for performance-critical code
size_t size() const noexcept { return data_.size(); }

// Assertions for programming errors
int& at(size_t i) {
    assert(i < data_.size());
    return data_[i];
}
```

### Testing with Google Test
```cpp
#include <gtest/gtest.h>

TEST(MathTest, Addition) {
    EXPECT_EQ(add(2, 3), 5);
    EXPECT_EQ(add(-1, 1), 0);
}

TEST(MathTest, ThrowsOnNegative) {
    EXPECT_THROW(sqrt_safe(-1), std::invalid_argument);
}

// Parameterized test
TEST_P(SortTest, SortsCorrectly) {
    auto input = GetParam();
    auto expected = input;
    std::sort(expected.begin(), expected.end());
    sort(input);
    EXPECT_EQ(input, expected);
}
```

---

## Phase 4 — Verification & Build

### Build with CMake
```powershell
cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build
./build/src/my_project
```

### Debug build
```powershell
cmake -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build
```

### Static analysis
```powershell
clang-tidy src/main.cpp -- -std=c++23
cppcheck --enable=all src/
```

### Sanitizers (debug builds)
```powershell
# Address sanitizer (memory errors)
cmake -B build -DCMAKE_CXX_FLAGS="-fsanitize=address -fno-omit-frame-pointer"
# Undefined behavior sanitizer
cmake -B build -DCMAKE_CXX_FLAGS="-fsanitize=undefined"
```

### Test
```powershell
cd build && ctest --output-on-failure
```

---

## Phase 5 — Quick Reference

| Practice | Why |
|---|---|
| Smart pointers | Automatic memory management |
| `std::span` | Flexible container parameters |
| `std::format`/`std::print` | Type-safe formatting |
| `constexpr`/`consteval` | Compile-time computation |
| Concepts | Readable template constraints |
| Ranges | Composable, lazy evaluation |
| `std::expected` | Type-safe error handling |
| RAII | Automatic resource management |
| `const` correctness | Safety, compiler optimization |
| `noexcept` | Performance, clear intent |
| `[[nodiscard]]` | Prevent ignoring return values |
| CMake + Ninja | Fast, portable builds |

---

## Rules
- Always detect the environment before suggesting installation.
- Use `run_shell` for all commands — verify each succeeds before continuing.
- Read existing project files before suggesting changes.
- Target C++20 or C++23 — use modern features.
- Never use raw `new`/`delete` — use smart pointers.
- Use RAII for all resource management.
- Use `const` and `constexpr` everywhere possible.
- Use `std::span` instead of `const std::vector&` for parameters.
- Use `std::expected` for error handling (C++23) or exceptions.
- Use CMake as the build system.
- Run static analysis (clang-tidy/cppcheck) and sanitizers in debug builds.

## Output
1. Environment status report
2. Installation/fix steps (if needed)
3. Project scaffold (if requested)
4. Code with modern C++20/23 patterns applied
5. Build, test, and static analysis verification