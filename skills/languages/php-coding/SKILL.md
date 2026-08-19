---
name: php-coding
command: /php
description: PHP environment setup, syntax rules, best practices, and project scaffolding.
---

# PHP Coding Skill

## Purpose
Guide the user through PHP environment detection, installation, project scaffolding, modern PHP 8.4+ syntax, PSR standards, and best practices.

## When to use
Use this skill when the user runs:

/php [subcommand]

Subcommands:
- (none) — Detect PHP environment, report status, and offer to fix issues
- new <project-name> — Scaffold a new PHP project
- check — Scan current project for env issues and best practice violations
- help — Show this help

---

## Phase 1 — Environment Detection & Installation

### Step 1: Detect existing PHP installation
Use `run_shell` to check:
```powershell
php --version
composer --version
where php
where composer
```

Check for web server and database:
```powershell
where apache     # or httpd
where nginx
where mysql
where sqlite3
where psql       # PostgreSQL
```

Check for additional tools:
```powershell
where phpstan    # Static analysis
where phpunit    # Testing
where xdebug     # Debugging/profiling
```

### Step 2: Report status
- ✅ / ❌ PHP (8.4+ recommended)
- ✅ / ❌ Composer (dependency manager)
- ✅ / ❌ Web server (Apache/Nginx) or built-in server
- ✅ / ❌ Database (MySQL/PostgreSQL/SQLite)
- ✅ / ❌ PHPStan (static analysis)
- ✅ / ❌ PHPUnit (testing)
- ✅ / ❌ Xdebug (debugging)

### Step 3: Install PHP if missing

**Windows — Option A: XAMPP (all-in-one):**
```powershell
winget install ApacheFriends.Xampp
# Includes PHP, Apache, MySQL, phpMyAdmin
```

**Windows — Option B: Manual PHP:**
```powershell
# Download from https://windows.php.net/download/
# Choose the Non-Thread Safe (NTS) version for IIS, or Thread Safe (TS) for Apache
# Extract to C:\php
# Add C:\php to PATH
# Copy php.ini-development to php.ini
# Edit php.ini: set extension_dir, enable extensions
```

**Windows — Option C: WAMP:**
```powershell
winget install WampServer.WampServer
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt update
sudo apt install php8.4 php8.4-cli php8.4-mysql php8.4-xml php8.4-curl php8.4-mbstring php8.4-zip
```

**macOS (Homebrew):**
```bash
brew install php@8.4
```

### Step 4: Install Composer
```powershell
# Windows
winget install Composer.Composer
# OR download from https://getcomposer.org/download/
```

```bash
# Linux/macOS
curl -sS https://getcomposer.org/installer | php
sudo mv composer.phar /usr/local/bin/composer
```

### Step 5: Install useful tools
```powershell
composer global require phpstan/phpstan
composer global require phpunit/phpunit
composer global require squizlabs/php_codesniffer
composer global require friendsofphp/php-cs-fixer
```

### Step 6: Configure php.ini
Key settings for development:
```ini
; Development settings
display_errors = On
display_startup_errors = On
error_reporting = E_ALL
log_errors = On

; Performance
opcache.enable = 1
opcache.enable_cli = 1
opcache.jit_buffer_size = 64M
opcache.jit = tracing

; Extensions (uncomment as needed)
extension=curl
extension=mbstring
extension=mysqli
extension=pdo_mysql
extension=xml
extension=zip
```

### Step 7: Verify
```powershell
php --version
composer --version
php -m    # List loaded modules
phpstan --version
phpunit --version
```

---

## Phase 2 — Project Scaffolding

### Option A: Plain PHP project
```
my-php-project/
├── composer.json
├── public/
│   └── index.php
├── src/
│   ├── Controllers/
│   ├── Models/
│   ├── Services/
│   └── Support/
├── config/
│   └── app.php
├── tests/
│   ├── Unit/
│   └── Feature/
├── .env
├── .gitignore
└── README.md
```

Create with:
```powershell
mkdir my-php-project
cd my-php-project
composer init
# Add autoloading:
# "autoload": { "psr-4": { "App\\": "src/" } }
composer dump-autoload
```

### Option B: Laravel project (full-stack framework)
```powershell
composer create-project laravel/laravel my-project
cd my-project
php artisan serve
```

### Option C: Symfony project
```powershell
composer create-project symfony/skeleton my-project
cd my-project
composer require webapp
php -S 127.0.0.1:8000 -t public
```

### Option D: Slim (micro framework)
```powershell
composer create-project slim/slim-skeleton my-project
cd my-project
php -S 127.0.0.1:8080 -t public
```

---

## Phase 3 — Syntax Rules & Best Practices

### Always Declare Strict Types
- **Every PHP file must start with `declare(strict_types=1);`**
- This prevents silent type coercion bugs
- Without it, `"5" + 3` silently equals `8` instead of throwing a `TypeError`

```php
<?php
declare(strict_types=1);

function calculateTax(float $amount): float
{
    return $amount * 0.15;
}

calculateTax("100");  // ❌ TypeError with strict_types
calculateTax(100.0);  // ✅ Correct
```

### PHP 8.4 Property Hooks
- **Eliminates getter/setter boilerplate** — attach logic directly to properties
- **Computed properties** without storing values
- **Adopt immediately in new code** — syntax is stable

```php
class User
{
    // Auto-capitalize names on set
    public string $name {
        set => ucfirst(strtolower($value));
    }

    // Email validation with property hooks
    public string $email {
        set {
            if (!filter_var($value, FILTER_VALIDATE_EMAIL)) {
                throw new InvalidArgumentException('Invalid email');
            }
            $this->email = strtolower($value);
        }
    }

    // Computed property — no stored value
    public string $displayName {
        get => "{$this->name} ({$this->email})";
    }
}
```

### Asymmetric Visibility (PHP 8.4)
- **Public read, controlled write** — eliminates getter-only boilerplate
- **Use for domain entities and DTOs**

```php
class Product
{
    public private(set) int $id;           // Public read, private write
    public protected(set) float $price;    // Public read, protected write
    public private(set) DateTime $createdAt;

    public function __construct(int $id, float $price)
    {
        $this->id = $id;
        $this->price = $price;
        $this->createdAt = new DateTime();
    }
}

$product = new Product(1, 99.99);
echo $product->price;     // ✅ Works: public read
$product->price = 150;   // ❌ Fatal error: protected set
```

### Constructor Property Promotion & Readonly Classes
- **Reduces class boilerplate by 60-70%**
- **Use `readonly class` (PHP 8.2+)** for DTOs, value objects, API responses
- **Don't use readonly for entities with mutable state**

```php
// ✅ Modern way: 6 lines total
readonly class UserDTO
{
    public function __construct(
        public string $name,
        public string $email,
        public int $age,
        public ?string $phone = null,
    ) {}
}

// Readonly class for value objects
readonly class Point
{
    public function __construct(
        public float $x,
        public float $y,
        public float $z = 0.0,
    ) {}

    public function distanceFrom(Point $other): float
    {
        return sqrt(
            ($this->x - $other->x) ** 2 +
            ($this->y - $other->y) ** 2 +
            ($this->z - $other->z) ** 2
        );
    }
}
```

### Enums (PHP 8.1+)
- **Use backed enums** for type-safe constants
- **Add methods** for business logic
- **Never use string constants** — use enums instead

```php
enum Status: string
{
    case PENDING = 'pending';
    case PROCESSING = 'processing';
    case COMPLETED = 'completed';
    case FAILED = 'failed';

    public function color(): string
    {
        return match($this) {
            self::PENDING => 'yellow',
            self::PROCESSING => 'blue',
            self::COMPLETED => 'green',
            self::FAILED => 'red',
        };
    }

    // State machine logic
    public function canTransitionTo(self $status): bool
    {
        return match($this) {
            self::PENDING => in_array($status, [self::PROCESSING, self::FAILED]),
            self::PROCESSING => in_array($status, [self::COMPLETED, self::FAILED]),
            self::COMPLETED, self::FAILED => false,
        };
    }
}
```

### Modern Type System
- **Union types** (PHP 8.0+): `int|float|string`
- **Intersection types** (PHP 8.1+): `Countable&ArrayAccess`
- **DNF types** (PHP 8.2+): `(Stringable&Countable)|null`
- **`never` return type** for functions that always throw or exit
- **Don't overuse union types** — if you have 5+ types, redesign

```php
// Union types
function process(int|float|string $number): string { ... }

// Intersection types
function save(Countable&ArrayAccess&Iterator $data): void { ... }

// DNF types
function handle((Stringable&Countable)|array|null $input): void { ... }

// Never return type
function abort(string $message, int $code = 500): never
{
    http_response_code($code);
    die(json_encode(['error' => $message]));
}
```

### Match Expressions
- **Use `match` over `switch`** — returns a value, exhaustive, strict comparison
- **No fall-through** — each arm is independent

```php
// ✅ Match expression
$status = match($statusCode) {
    200, 201 => 'success',
    404 => 'not found',
    500 => 'server error',
    default => 'unknown',
};

// Match with enum
$color = match($status) {
    Status::PENDING => 'yellow',
    Status::PROCESSING => 'blue',
    Status::COMPLETED => 'green',
    Status::FAILED => 'red',
};
```

### PHP 8.5 Features
- **Pipe operator `|>`** — chain function calls left to right
- **`array_first()` / `array_last()`** — replace `reset()`/`end()` patterns
- **Core `Clock` interface** — testable time abstraction
- **`#[NoDiscard]` attribute** — warn when return values are ignored

```php
// Pipe operator (PHP 8.5)
$result = $input |> trim(...) |> strtolower(...) |> htmlspecialchars(...);

// Array helpers (PHP 8.5)
$first = array_first($items);
$last = array_last($items);

// Clock interface (PHP 8.5)
interface Clock { public function now(): DateTimeImmutable; }
class SystemClock implements Clock { public function now(): DateTimeImmutable { return new DateTimeImmutable(); } }
```

### Array Helpers (PHP 8.4+)
```php
// array_find — first matching element
$activeUser = array_find($users, fn($u) => $u->isActive());

// array_find_key — key of first matching element
$key = array_find_key($users, fn($u) => $u->isAdmin());

// array_all — true if all match
$allValid = array_all($emails, fn($e) => filter_var($e, FILTER_VALIDATE_EMAIL));

// array_any — true if any match
$hasAdmin = array_any($users, fn($u) => $u->isAdmin());
```

### Error Handling
- **Use exceptions, not return codes**
- **Create custom exception hierarchies**
- **Catch specific exceptions**, not `Throwable` broadly

```php
class DomainException extends RuntimeException {}
class ValidationException extends DomainException {}
class UserNotFoundException extends DomainException {}

try {
    $user = $userRepository->findById($id);
} catch (UserNotFoundException $e) {
    return ApiResponse::error('User not found', 404);
} catch (ValidationException $e) {
    return ApiResponse::error($e->getMessage(), 422);
}
```

### PSR Standards Compliance
- **PSR-1**: Basic coding standard
- **PSR-4**: Autoloading standard (`"App\\" => "src/"`)
- **PSR-12**: Extended coding style guide
- **PSR-3**: Logger interface
- **PSR-7**: HTTP message interfaces
- **PSR-11**: Container interface
- **PSR-15**: HTTP middleware

```php
// PSR-4 autoloading in composer.json
{
    "autoload": {
        "psr-4": {
            "App\\": "src/"
        }
    }
}

// PSR-12 compliant class
declare(strict_types=1);

namespace App\Models;

use App\Exceptions\ValidationException;

class User
{
    public function __construct(
        private string $email,
    ) {
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new ValidationException('Invalid email');
        }
    }

    public function getEmail(): string
    {
        return $this->email;
    }
}
```

### Security Best Practices
- **Never trust user input** — validate and sanitize everything
- **Use prepared statements** for database queries (PDO or parameterized queries)
- **Use `password_hash()` / `password_verify()`** — never store plain text passwords
- **Use CSRF tokens** for forms
- **Escape output** with `htmlspecialchars()` to prevent XSS
- **Set `session.cookie_httponly = 1`** and `session.cookie_secure = 1`

```php
// Prepared statements (SQL injection prevention)
$stmt = $pdo->prepare('SELECT * FROM users WHERE email = :email');
$stmt->execute(['email' => $email]);
$user = $stmt->fetch();

// Password hashing
$hash = password_hash($password, PASSWORD_DEFAULT);
if (password_verify($input, $hash)) { /* valid */ }

// XSS prevention
echo htmlspecialchars($userInput, ENT_QUOTES, 'UTF-8');
```

### Testing with PHPUnit
```php
use PHPUnit\Framework\TestCase;

class UserTest extends TestCase
{
    public function test_user_can_be_created(): void
    {
        $user = new User('user@example.com');
        $this->assertSame('user@example.com', $user->getEmail());
    }

    public function test_invalid_email_throws(): void
    {
        $this->expectException(ValidationException::class);
        new User('not-an-email');
    }
}
```

---

## Phase 4 — Verification & Build

### Lint and static analysis
```powershell
php -l src/                    # Syntax check
phpstan analyse src/ --level=9  # Static analysis (aim for level 9)
php-cs-fixer fix src/          # Fix coding standards
phpcs --standard=PSR12 src/    # Check PSR-12 compliance
```

### Test
```powershell
vendor/bin/phpunit
vendor/bin/phpunit --coverage-text
```

### Run development server
```powershell
php -S 127.0.0.1:8000 -t public/
# Laravel
php artisan serve
# Symfony
php -S 127.0.0.1:8000 -t public/
```

---

## Phase 5 — Quick Reference

| Practice | Why |
|---|---|
| `declare(strict_types=1)` | Prevents silent type coercion bugs |
| Property hooks (8.4) | Eliminate getter/setter boilerplate |
| Asymmetric visibility (8.4) | Public read, controlled write |
| `readonly class` (8.2) | Immutable DTOs and value objects |
| Enums (8.1) | Type-safe constants, no string typos |
| `match` over `switch` | Returns value, exhaustive, strict |
| Prepared statements | SQL injection prevention |
| `password_hash()` | Secure password storage |
| `htmlspecialchars()` | XSS prevention |
| PSR-12 compliance | Community coding standard |
| PHPStan level 9 | Bulletproof static analysis |
| Constructor promotion | 60-70% less boilerplate |

---

## Rules
- Always detect the environment before suggesting installation.
- Use `run_shell` for all commands — verify each succeeds before continuing.
- Read existing project files before suggesting changes.
- Every PHP file must start with `declare(strict_types=1);`.
- Use PHP 8.4+ features: property hooks, asymmetric visibility, enums, readonly classes.
- Never use `var_dump` or `die` in production code — use proper exception handling.
- Never store plain text passwords — use `password_hash()`.
- Always validate and sanitize user input.
- Use prepared statements for all database queries.
- Run PHPStan and PHPUnit after making changes.
- Follow PSR-12 coding standards.

## Output
1. Environment status report
2. Installation/fix steps (if needed)
3. Project scaffold (if requested)
4. Code with modern PHP 8.4+ patterns applied
5. Lint, static analysis, and test verification