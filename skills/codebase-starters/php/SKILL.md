---
name: php
description: >-
  Production PHP 8.3+ codebase starter, Composer, PSR-12, Laravel/Symfony patterns, PHPUnit, PHPStan level 8+, OPcache, and harness verification.
---

# PHP Codebase & Engineering Skill

Comprehensive operational guide, starter architecture, best practices, and harness controls for modern PHP engineering.

## 1. Stack Overview & Dependencies
- **Runtime**: PHP 8.2 / 8.3+
- **Package Manager**: Composer (`composer.json`)
- **Framework Choices**: Laravel 11+, Symfony 7+, or Clean PSR Microservice
- **Core Dependencies**:
  - `guzzlehttp/guzzle`: HTTP client
  - `monolog/monolog`: PSR-3 logging framework
  - `vlucas/phpdotenv`: Environment configuration
  - `phpunit/phpunit`: Testing framework
  - `phpstan/phpstan`: Static type analysis tool (Level 8+)
  - `friendsofphp/php-cs-fixer`: PSR-12 code style formatter

## 2. Standard Codebase Structure
```text
php-service/
├── composer.json
├── composer.lock
├── README.md
├── public/
│   └── index.php
├── src/
│   ├── App.php
│   ├── Config/
│   ├── Models/
│   └── Services/
└── tests/
    └── AppTest.php
```

## 3. How-To Workflows

### Install Dependencies & Autoload
```bash
composer install
composer dump-autoload -o
```

### Serve Local Application
```bash
php -S localhost:8000 -t public
```

### Static Analysis & Formatting
```bash
# Code style check & format
vendor/bin/php-cs-fixer fix --dry-run
vendor/bin/php-cs-fixer fix

# Run PHPStan Level 8
vendor/bin/phpstan analyse src --level=8
```

### Testing & Verification
```bash
vendor/bin/phpunit
```

## 4. Best Practices & Design Patterns
1. **Strict Typing**: Declare `declare(strict_types=1);` at the top of every `.php` file. Use typed properties and explicit return types.
2. **Dependency Injection**: Inject dependencies via class constructors; avoid global state or static facade abuse.
3. **PSR Standards**: Adhere to PSR-4 (Autoloading), PSR-7/PSR-17 (HTTP Messages), PSR-11 (Container), PSR-12 (Coding Style).
4. **Readonly Classes & Enums**: Use PHP 8.2+ `readonly class` for immutable DTOs and Backed Enums (`enum Role: string`).
5. **Match Expressions**: Prefer `match ($val)` over legacy `switch` statements for strict value comparison and expressions.

## 5. Tips, Tricks & Pitfalls
- **Nullsafe Operator**: Use `$object?->method()` to simplify null checks cleanly.
- **OPcache & JIT**: Ensure `opcache.enable_cli=1` and JIT are enabled in production `php.ini`.
- **SQL Injection Prevention**: Always use PDO Prepared Statements with bound parameters.

## 6. Harness Hooks & Safety Enforcement
- **PreToolUse Guard**: Run `php -l` lint check on script files before executing.
- **PostToolUse Verification**: Trigger `phpstan analyse` and `phpunit` automatically after editing PHP files.
