---
name: ruby
description: >-
  Production Ruby 3.3+ codebase starter, Bundler, RuboCop, RSpec, Rails/Sinatra patterns, YJIT performance optimization, and harness verification for Ruby engineering.
---

# Ruby Codebase & Engineering Skill

Comprehensive operational guide, starter architecture, best practices, and harness controls for Ruby and Rails/Sinatra backend engineering.

## 1. Stack Overview & Dependencies
- **Runtime**: Ruby 3.3+ (with YJIT enabled `--yjit`)
- **Package & Dependency Manager**: Bundler (`Gemfile` / `Gemfile.lock`)
- **Frameworks**: Ruby on Rails 7.1+, Sinatra, or Hanami
- **Core Dependencies**:
  - `rspec`: Behavior-driven testing framework
  - `rubocop` & `rubocop-performance`: Code style and performance linter
  - `puma`: High-concurrency HTTP web server
  - `concurrent-ruby`: Modern concurrency primitives
  - `zeitwerk`: Code autoloader

## 2. Standard Codebase Structure
```text
ruby-app/
├── Gemfile
├── Gemfile.lock
├── README.md
├── Rakefile
├── app.rb
├── lib/
│   └── app/
│       ├── core_engine.rb
│       └── models/
└── spec/
    ├── spec_helper.rb
    └── core_engine_spec.rb
```

## 3. How-To Workflows

### Install Dependencies
```bash
bundle install
```

### Dev Mode Execution
```bash
# Enable YJIT compiler for high execution speed
ruby --yjit app.rb
```

### Static Analysis & Code Formatting
```bash
# Run RuboCop linter
bundle exec rubocop

# Auto-correct lint violations
bundle exec rubocop -A
```

### Testing & Verification
```bash
bundle exec rspec --format documentation
```

## 4. Best Practices & Design Patterns
1. **Ruby 3 Fiber & YJIT Concurrency**: Leverage Ruby 3 Fiber scheduler and enable `--yjit` in production to achieve 20-40% lower response latencies.
2. **Immutable Frozen String Literals**: Declare `# frozen_string_literal: true` at the top of every file to avoid useless string object allocations.
3. **Keyword Arguments**: Prefer explicit keyword arguments (`def process(user_id:, score:)`) over positional arrays or implicit options hashes.
4. **Enumerable Operations**: Leverage Ruby's expressive `Enumerable` module (`select`, `map`, `reduce`, `flat_map`, `partition`).
5. **DRY Class Contracts & Modules**: Use Mixins (`include` / `prepend` / `extend`) cleanly without polluting object ancestor chains.

## 5. Tips, Tricks & Pitfalls
- **N+1 Database Queries**: In Rails, always use `.includes(:relation)` or `.eager_load()` to eliminate N+1 queries.
- **Safe Navigation Operator**: Use `&.` (`user&.name`) to prevent `NoMethodError` on `nil` objects.
- **Mutating Methods (`!`)**: Methods ending in `!` (e.g. `strip!`, `save!`) mutate the object or raise an error; use with caution.

## 6. Harness Hooks & Safety Enforcement
- **PreToolUse Guard**: Validate Ruby syntax (`ruby -c`) before execution.
- **PostToolUse Verification**: Trigger `bundle exec rubocop` and `rspec` automatically after editing Ruby scripts.
