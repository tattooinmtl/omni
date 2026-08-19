---
name: ruby-coding
command: /ruby
description: Ruby environment setup, syntax rules, best practices, and project scaffolding.
---

# Ruby Coding Skill

## Purpose
Guide the user through Ruby environment detection, installation, project scaffolding, modern Ruby 3.4+ syntax, style guide, and best practices.

## When to use
Use this skill when the user runs:

/ruby [subcommand]

Subcommands:
- (none) — Detect Ruby environment, report status, and offer to fix issues
- new <project-name> — Scaffold a new Ruby project
- check — Scan current project for env issues and best practice violations
- help — Show this help

---

## Phase 1 — Environment Detection & Installation

### Step 1: Detect existing Ruby installation
Use `run_shell` to check:
```powershell
ruby --version
where gem
where bundle
where rubocop
where rake
```

Check for version managers:
```powershell
where rbenv
where rvm
where chruby
```

### Step 2: Report status
- ✅ / ❌ Ruby (3.4+ recommended)
- ✅ / ❌ RubyGems (gem)
- ✅ / ❌ Bundler (bundle)
- ✅ / ❌ RuboCop (linter/formatter)
- ✅ / ❌ Rake (task runner)
- ✅ / ❌ Version manager (rbenv/rvm/chruby)

### Step 3: Install Ruby if missing

**Windows:**
```powershell
# Option A: RubyInstaller (recommended for Windows)
# Download from https://rubyinstaller.org/ and run the installer
# Select "Add Ruby executables to your PATH"
# Select "Install MSYS2 build tools" for native gem compilation

# Option B: winget
winget install RubyInstallerTeam.Ruby.3.4

# Option C: rbenv for Windows (PowerShell-based)
# See https://github.com/RubyMetric/rbenv-for-windows
```

**Linux:**
```bash
# Using rbenv (recommended)
curl -fsSL https://github.com/rbenv/rbenv-installer/raw/HEAD/bin/rbenv-installer | bash
rbenv install 3.4.0
rbenv global 3.4.0

# Using system package manager
sudo apt install ruby-full
```

**macOS:**
```bash
# Using Homebrew
brew install ruby@3.4

# Using rbenv
brew install rbenv ruby-build
rbenv install 3.4.0
rbenv global 3.4.0
```

### Step 4: Install Bundler and RuboCop
```powershell
gem install bundler
gem install rubocop
gem install rake
```

### Step 5: Verify
```powershell
ruby --version
gem --version
bundle --version
rubocop --version
```

---

## Phase 2 — Project Scaffolding

### Option A: Plain Ruby project
```
my_ruby_project/
├── Gemfile
├── Rakefile
├── lib/
│   ├── my_project.rb
│   └── my_project/
│       ├── version.rb
│       └── core.rb
├── spec/
│   ├── spec_helper.rb
│   └── my_project_spec.rb
├── bin/
│   └── my_project
└── README.md
```

Create with:
```powershell
mkdir my_ruby_project
cd my_ruby_project
bundle init    # Creates Gemfile
```

### Option B: Ruby gem (library)
```powershell
bundle gem my_gem
cd my_gem
```

### Option C: Rails project (full-stack web framework)
```powershell
gem install rails
rails new my_app
cd my_app
bundle install
rails server
```

### Gemfile
```ruby
source "https://rubygems.org"

ruby "3.4.0"

gem "httparty"
gem "json"

group :development, :test do
  gem "rspec"
  gem "rubocop", require: false
  gem "rake"
end
```

---

## Phase 3 — Syntax Rules & Best Practices

### Ruby 3.4 Features

#### `it` as anonymous block parameter
```ruby
# Ruby 3.4+ — `it` is the anonymous block parameter
[1, 2, 3].map { it**2 }  #=> [1, 4, 9]

# Works in nested blocks (unlike numbered params)
[[1, 2], [3, 4]].each { it.each { p it } }
# prints 1, 2, 3, 4

# `it` is a soft keyword — still works as variable/method name
# But cannot mix with numbered params (_1, _2)
```

#### `**nil` unpacks to empty keyword arguments
```ruby
def handle_options(**kwargs) = p kwargs
handle_options(**nil)  # Ruby 3.4: prints {} (Ruby 3.3: TypeError)

# Practical: conditional options passing
handle_options(**(extra_options if some_condition?))
```

#### String literals will be frozen in Ruby 3.5
- Ruby 3.4 emits deprecation warnings when modifying string literals
- Prepare by adding `# frozen_string_literal: true` magic comment
- Use `+` or `<<` for mutable strings when needed

```ruby
# frozen_string_literal: true

name = "Alice"
name << " Smith"  # ❌ Warning in 3.4, Error in 3.5
name = "Alice" + " Smith"  # ✅ Creates new string
```

### Naming Conventions
- **Variables and methods**: `snake_case` (e.g., `fetch_user`)
- **Classes and modules**: `CamelCase` (e.g., `HttpClient`)
- **Constants**: `SCREAMING_SNAKE_CASE` (e.g., `MAX_CONNECTIONS`)
- **Files**: `snake_case.rb` (e.g., `user_service.rb`)
- **Directories**: `snake_case`
- **Predicate methods**: end with `?` (e.g., `empty?`, `active?`)
- **Dangerous methods**: end with `!` (e.g., `save!`, `sort!`)
- **Use English** for identifiers — not transliterated non-English

### Source Code Layout
- **Use UTF-8** as source file encoding
- **Use 2 spaces** for indentation — no tabs
- **Maximum line length**: 80 characters (recommended)
- **No trailing whitespace**
- **End files with a newline**
- **One expression per line** — no `;` to separate
- **Spaces around operators**: `x = 1 + 2`, not `x=1+2`
- **No space after bang**: `!x`, not `! x`
- **No space inside range literals**: `1..10`, not `1.. 10`
- **Indent `when` to `case`** level
- **Trailing comma** in multi-line method arguments**

```ruby
# Good — trailing comma in multi-line
def send_mail(source)
  Mail.deliver(
    to: "bob@example.com",
    from: "us@example.com",
    subject: "Important message",
    body: source.text,
  )
end
```

### Flow of Control
- **Never use `for` loops** — use `each` instead
- **Use `unless` instead of `if !`**
- **Use `until` instead of `while !`**
- **Never use `and`/`or`** — use `&&`/`||`
- **Avoid double negation** `!!` — use explicit boolean
- **Use modifier `if`/`unless` for single-line guards**
- **Return result from `if`/`case`** — they are expressions

```ruby
# ❌ Bad — for loop
for item in items
  process(item)
end

# ✅ Good — each
items.each { |item| process(item) }

# ✅ Good — unless instead of if !
do_something unless ready?

# ✅ Good — modifier if/unless for guards
return if empty?

# ✅ Good — if/case returns a value
result = if user.active?
  "Active"
else
  "Inactive"
end
```

### Blocks, Procs & Lambdas
- **Use `{}` for single-line blocks**, `do...end` for multi-line
- **Prefer lambdas over procs** — lambdas check arity
- **Use `->` (stabby lambda) for lambda definitions**
- **Pass blocks explicitly with `&block`** when needed

```ruby
# Single-line block with {}
items.map { |item| item.upcase }

# Multi-line block with do...end
items.each do |item|
  process(item)
  log(item)
end

# Stabby lambda
square = ->(x) { x**2 }
square.call(5)  # => 25

# Ruby 3.4 anonymous it
[1, 2, 3].map { it**2 }
```

### Methods
- **Keep methods short** — 5-10 lines max
- **No single-line methods** — use endless methods (Ruby 3.0+)
- **Use keyword arguments** for options, not option hashes
- **Limit parameters** — max 3-4, use keyword args for more
- **Use argument forwarding** (`...`) when passing all args through

```ruby
# Endless method (Ruby 3.0+)
def square(x) = x**2

# Keyword arguments
def create_user(name:, email:, role: "user")
  # ...
end

# Argument forwarding (Ruby 3.0+)
def forward_all(...)
  log(...)
  process(...)
end
```

### Classes & Modules
- **One class per file**
- **Use `attr_accessor`, `attr_reader`, `attr_writer`** — not manual getters/setters
- **Use `Struct` or `Data.define`** for simple value objects
- **Leverage access modifiers** (`private`, `protected`)
- **Define class methods with `self.` prefix**
- **Use modules for mixins** — group related methods
- **Prefer composition over inheritance**

```ruby
# Struct for simple value objects
Point = Struct.new(:x, :y) do
  def distance_from(other)
    Math.sqrt((x - other.x)**2 + (y - other.y)**2)
  end
end

# Data.define (Ruby 3.2+) — immutable value objects
Point = Data.define(:x, :y) do
  def distance_from(other)
    Math.sqrt((x - other.x)**2 + (y - other.y)**2)
  end
end

# Access modifiers
class User
  attr_reader :name, :email

  def initialize(name, email)
    @name = name
    @email = email
  end

  private

  def validate_email
    @email.match?(/\A[\w.]+@[\w.]+\z/)
  end
end
```

### Collections
- **Use literal syntax** for arrays and hashes: `[]`, `{}`
- **Use `%w` for word arrays**: `%w[apple banana cherry]`
- **Use symbols as hash keys** — not strings
- **Use `fetch` for hash access** with defaults — not `[]` with `||`
- **Don't modify collections while iterating** — use `map`, `select`, `reduce`
- **Use `flat_map`** instead of `map` + `flatten(1)`

```ruby
# ✅ Good — literal syntax
arr = [1, 2, 3]
hash = { name: "Alice", age: 30 }

# ✅ Good — fetch with default
name = hash.fetch(:name, "Unknown")

# ✅ Good — map/select/reduce
squares = arr.map { |x| x**2 }
evens = arr.select(&:even?)
sum = arr.reduce(0, :+)

# ✅ Good — flat_map
results = items.flat_map { |item| item.children }
```

### Strings
- **Use string interpolation** — not concatenation
- **Prefer double quotes** for strings with interpolation
- **Use heredocs** for multi-line strings
- **Use squiggly heredocs** (`<<~`) for indented heredocs

```ruby
# String interpolation
name = "Alice"
greeting = "Hello, #{name}!"

# Squiggly heredoc (strips leading whitespace)
query = <<~SQL
  SELECT * FROM users
  WHERE active = true
  ORDER BY name
SQL
```

### Exceptions
- **Use `raise` not `fail`** for raising exceptions
- **Raise specific exceptions** — not bare `RuntimeError`
- **Never rescue `Exception`** — rescue `StandardError` or specific classes
- **Don't use exceptions for flow control**
- **Order rescues from most specific to least specific**

```ruby
class DomainError < StandardError; end
class ValidationError < DomainError; end
class NotFoundError < DomainError; end

def find_user(id)
  user = repository.find(id)
  raise NotFoundError, "User #{id} not found" if user.nil?
  user
rescue DatabaseError => e
  raise DomainError, "Database error: #{e.message}"
end
```

### Pattern Matching (Ruby 2.7+)
- **Use `case`/`in`** for pattern matching
- **Destructure arrays and hashes** in patterns
- **Use `^` for pinning variables** in patterns

```ruby
case command
in ["quit"]
  exit_app
in ["move", x, y]
  move_player(x, y)
in ["attack", target]
  attack(target)
else
  puts "Unknown command"
end

# Hash pattern matching
case user
in { name:, role: "admin" }
  puts "Admin: #{name}"
in { name:, role: "user" }
  puts "User: #{name}"
end
```

### Testing with RSpec
```ruby
# spec/spec_helper.rb
require "my_project"

RSpec.configure do |config|
  config.expect_with :rspec do |expectations|
    expectations.include_chain_clauses_in_custom_matcher_descriptions = true
  end
end

# spec/my_project_spec.rb
RSpec.describe MyProject do
  describe "#add" do
    it "adds two numbers" do
      expect(MyProject.add(2, 3)).to eq(5)
    end

    context "with negative numbers" do
      it "handles negative results" do
        expect(MyProject.add(-1, -2)).to eq(-3)
      end
    end
  end
end
```

---

## Phase 4 — Verification & Build

### Lint and format
```powershell
rubocop                    # Check style
rubocop -a                # Auto-fix safe offenses
rubocop -A                # Auto-fix all offenses (use with caution)
rubocop --format progress # Progress format
```

### Test
```powershell
rspec                      # Run all tests
rspec --format documentation  # Documentation format
rspec --tag type:unit       # Run specific tags
```

### Run
```powershell
ruby lib/my_project.rb     # Run a script
bundle exec ruby app.rb    # Run with bundled gems
rails server               # Run Rails server
```

---

## Phase 5 — Quick Reference

| Practice | Why |
|---|---|
| `each` over `for` | Idiomatic Ruby |
| `unless` over `if !` | Readability |
| `&&`/`||` over `and`/`or` | Correct precedence |
| Keyword args over option hashes | Clarity, IDE support |
| `attr_reader`/`attr_accessor` | Less boilerplate |
| `Struct`/`Data.define` for value objects | Immutable, clean |
| `fetch` with default for hashes | Explicit fallback |
| String interpolation | Readability over concatenation |
| `raise` with specific exceptions | Better error handling |
| Pattern matching (`case`/`in`) | Destructuring, exhaustive |
| `frozen_string_literal: true` | Prepare for Ruby 3.5 |
| RuboCop | Enforced style guide |

---

## Rules
- Always detect the environment before suggesting installation.
- Use `run_shell` for all commands — verify each succeeds before continuing.
- Read existing project files before suggesting changes.
- Follow the Ruby Style Guide (rubystyle.guide) — use RuboCop to enforce.
- Never use `for` loops — use `each`.
- Never use `and`/`or` — use `&&`/`||`.
- Never rescue bare `Exception` — rescue `StandardError` or specific classes.
- Use `frozen_string_literal: true` magic comment in all new files.
- Keep methods short (5-10 lines) and focused.
- Use keyword arguments for options, not option hashes.
- Run RuboCop after making changes.
- Prefer composition over inheritance.

## Output
1. Environment status report
2. Installation/fix steps (if needed)
3. Project scaffold (if requested)
4. Code with idiomatic Ruby patterns applied
5. RuboCop and test verification