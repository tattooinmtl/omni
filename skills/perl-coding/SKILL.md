---
name: perl-coding
command: /perl
description: Perl environment setup, syntax rules, best practices, and project scaffolding.
---

# Perl Coding Skill

## Purpose
Guide the user through Perl environment detection, installation, project scaffolding, modern Perl 5.40+ syntax, and best practices.

## When to use
Use this skill when the user runs:

/perl [subcommand]

Subcommands:
- (none) — Detect Perl environment, report status, and offer to fix issues
- new <project-name> — Scaffold a new Perl project
- check — Scan current project for env issues and best practice violations
- help — Show this help

---

## Phase 1 — Environment Detection & Installation

### Step 1: Detect existing Perl installation
Use `run_shell` to check:
```powershell
perl --version
where cpan
where cpanm
where perlbrew
where perlcritic
where prove
```

### Step 2: Report status
- ✅ / ❌ Perl (5.40+ recommended)
- ✅ / ❌ CPAN (module installer)
- ✅ / ❌ cpanm (App::cpanminus — faster installer)
- ✅ / ❌ perlbrew (version manager)
- ✅ / ❌ Perl::Critic (static analysis)
- ✅ / ❌ prove (test runner)

### Step 3: Install Perl if missing

**Windows:**
```powershell
# Option A: Strawberry Perl (recommended — includes compiler toolchain)
# Download from http://strawberryperl.com/ and run the MSI installer
# OR:
winget install StrawberryPerl.StrawberryPerl

# Option B: ActivePerl (enterprise)
# Download from https://www.activestate.com/products/perl/
```

**Linux:**
```bash
# System package manager
sudo apt install perl

# Using perlbrew (version management)
\curl -L https://install.perlbrew.pl | bash
perlbrew install perl-5.40.0
perlbrew switch perl-5.40.0
```

**macOS:**
```bash
# Perl is pre-installed, but to get latest:
brew install perl
# OR
perlbrew install perl-5.40.0
```

### Step 4: Install cpanminus and useful tools
```powershell
cpan App::cpanminus
cpanm Perl::Critic
cpanm Perl::Tidy
cpanm Test::More
cpanm Test::Exception
```

### Step 5: Verify
```powershell
perl --version
cpanm --version
perlcritic --version
prove --version
```

---

## Phase 2 — Project Scaffolding

### Plain Perl project
```
my_perl_project/
├── dist.ini              # or Makefile.PL / Build.PL
├── lib/
│   └── MyProject/
│       ├──.pm
│       └── Core.pm
├── bin/
│   └── my_project
├── t/
│   ├── 00-load.t
│   ├── 01-basic.t
│   └── 02-features.t
└── README.md
```

### Create with Module::Starter
```powershell
cpanm Module::Starter
module-starter --module=MyProject --author="Your Name" --email="you@example.com"
cd MyProject
```

### Create with Dist::Zilla
```powershell
cpanm Dist::Zilla
dzil new MyProject
cd MyProject
```

### Simple script project
```
my_script/
├── script.pl
├── lib/
│   └── Helper.pm
└── t/
    └── helper.t
```

---

## Phase 3 — Syntax Rules & Best Practices

### Always use `strict` and `warnings`
- **Every Perl file must start with `use strict; use warnings;`**
- Or use `use v5.40;` which enables them automatically
- This catches typos, undefined variables, and common mistakes

```perl
use v5.40;  # Enables strict, warnings, and all modern features
# OR explicitly:
use strict;
use warnings;
```

### Modern Perl 5.40 Features

#### Object-Oriented Programming (Corinna — core OO)
- **Use the `class` feature** for modern OO — no need for Moose or Moo
- **`field`** for instance variables with `:param` for constructor params
- **`:reader`** attribute auto-generates getter methods
- **`__CLASS__`** keyword for runtime class dispatch

```perl
use v5.40;
use experimental 'class';

class Employee {
    field $name :param :reader;
    field $age  :param :reader(get_age);
    field $email :param;

    method validate_email {
        return $email =~ /\A[\w.]+@[\w.]+\z/;
    }

    method summary {
        return sprintf("%s (age %d)", $name, $age);
    }
}

my $emp = Employee->new(name => "Joe", age => 40, email => "joe@example.com");
say $emp->name;      # Joe
say $emp->get_age;   # 40
say $emp->summary;   # Joe (age 40)
```

#### try/catch (stable in 5.40)
- **No longer experimental** — no `use experimental 'try'` needed
- Use for structured exception handling

```perl
use v5.40;

try {
    my $result = divide(10, 0);
} catch ($e) {
    say "Error: $e";
}

sub divide {
    my ($a, $b) = @_;
    die "Division by zero" if $b == 0;
    return $a / $b;
}
```

#### for iterating over multiple values (stable in 5.40)
```perl
use v5.40;

for my ($key, $value) (%hash) {
    say "$key => $value";
}

for my ($x, $y) (1, 2, 3, 4, 5, 6) {
    say "($x, $y)";
}
```

#### `^^` logical XOR operator
```perl
use v5.40;

my $is_admin = 1;
my $is_readonly = 0;

$is_admin ^^ $is_readonly and say "One is true, but not both";
```

### Variable Naming and Sigils
- **`$` for scalars**: `$name`, `$count`
- **`@` for arrays**: `@items`, `@users`
- **`%` for hashes**: `%config`, `%options`
- **`&` for subroutines**: `&handler` (rarely needed in modern Perl)
- **Use `snake_case`** for variable and subroutine names
- **Use `CamelCase`** for package/module names

### Subroutines
- **Always use `my` for lexical variables** — never global
- **Use named parameters** via hash or hash slice for clarity
- **Return explicitly** — don't rely on implicit return
- **Use signatures** (stable since Perl 5.36)

```perl
use v5.40;
use feature 'signatures';
no warnings 'experimental::signatures';

# Subroutine signatures
sub greet ($name, $greeting = "Hello") {
    return "$greeting, $name!";
}

say greet("Alice");           # Hello, Alice!
say greet("Bob", "Welcome");  # Welcome, Bob!

# Named parameters via signature with hash
sub create_user ($name, $email, $role = "user") {
    return {
        name  => $name,
        email => $email,
        role  => $role,
    };
}
```

### Regular Expressions
- **Use `=~` for matching** — not implicit `$_` matching
- **Use `/x` modifier** for complex patterns — allows whitespace and comments
- **Use named captures** `(?<name>...)` for readability
- **Prefer non-capturing groups** `(?:...)` when you don't need the capture

```perl
# Named captures
if ($text =~ /(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})/) {
    say "Year: $+{year}, Month: $+{month}, Day: $+{day}";
}

# Extended regex with /x
my $pattern = qr{
    ^           # Start of string
    \w+         # Word characters
    @           # At sign
    [\w.]+      # Domain
    \.          # Dot
    [a-z]{2,}   # TLD
    $           # End of string
}xi;

if ($email =~ $pattern) {
    say "Valid email";
}
```

### Error Handling
- **Use `try`/`catch`** (stable in 5.40) for structured exceptions
- **Use `die` with meaningful messages** — include context
- **Never use `eval` without checking `$@`** — use `try`/`catch` instead
- **Use `autodie`** to automatically die on failed system calls

```perl
use v5.40;
use autodie qw(open close);

try {
    open my $fh, '<', $filename;
    my $content = do { local $/; <$fh> };
    close $fh;
    return $content;
} catch ($e) {
    say "Failed to read $filename: $e";
    return;
}
```

### Modules and Packages
- **One package per file**
- **File name matches package name** (e.g., `MyProject/Core.pm` → `MyProject::Core`)
- **Use `Exporter`** for public functions
- **Use `use parent`** for inheritance — not `@ISA` directly

```perl
package MyProject::Core;
use v5.40;
use Exporter 'import';

our @EXPORT_OK = qw(process transform);

sub process {
    my ($data) = @_;
    # ...
}

sub transform {
    my ($input) = @_;
    # ...
}

1;  # Every module must return true
```

### Testing with Test::More and prove
- **Test files go in `t/`** directory
- **Test files end with `.t`**
- **Use `Test::More`** for basic testing
- **Use `Test::Exception`** for exception testing
- **Run tests with `prove`**

```perl
# t/01-basic.t
use v5.40;
use Test::More tests => 3;
use MyProject::Core qw(process transform);

ok(defined &process, 'process is exported');
ok(defined &transform, 'transform is exported');

is(process("test"), "expected", 'process returns expected value');

# Exception testing
use Test::Exception;
dies_ok { process(undef) } 'process dies on undef input';
```

### Security Best Practices
- **Never use `eval` on user input** — it can execute arbitrary code
- **Always use placeholders** in DBI queries — never interpolate variables
- **Use `taint` mode** (`-T` flag) for security-sensitive scripts
- **Escape output** when generating HTML to prevent XSS
- **Use `use strict` and `use warnings`** — catches many security issues

```perl
# DBI with placeholders (SQL injection prevention)
my $sth = $dbh->prepare("SELECT * FROM users WHERE email = ?");
$sth->execute($email);

# Taint mode
#!/usr/bin/perl -T
use v5.40;

# HTML escaping
use HTML::Entities;
my $safe = encode_entities($user_input);
```

### Performance
- **Use `map`, `grep`, `sort`** — they are faster than manual loops
- **Precompile regexes** with `qr//` for repeated use
- **Use `Benchmark`** to compare approaches
- **Avoid unnecessary string copies** — use references for large data

```perl
# Precompile regex
my $pattern = qr/^\w+@\w+\.\w+$/;
for my $email (@emails) {
    next unless $email =~ $pattern;
    # ...
}

# map/grep/sort
my @active = grep { $_->{active} } @users;
my @names  = map  { $_->{name} } @active;
my @sorted = sort { $a->{name} cmp $b->{name} } @active;
```

---

## Phase 4 — Verification & Build

### Lint and format
```powershell
perlcritic lib/            # Static analysis
perlcritic --stern lib/    # Stricter analysis
perltidy -b lib/*.pm      # Format code (in-place backup)
```

### Test
```powershell
prove -v                  # Run all tests verbosely
prove -l t/               # Run tests with lib/ in @INC
prove --timer t/          # Show timing
```

### Run
```powershell
perl script.pl            # Run a script
perl -Ilib script.pl      # Run with lib/ in @INC
perl -c script.pl         # Syntax check only
perl -d script.pl         # Run with debugger
```

---

## Phase 5 — Quick Reference

| Practice | Why |
|---|---|
| `use strict; use warnings;` | Catches typos, undefined vars, common mistakes |
| `use v5.40;` | Enables all modern features + strict + warnings |
| `class` feature (Corinna) | Modern core OO — no Moose needed |
| `try`/`catch` (stable 5.40) | Structured exception handling |
| Subroutine signatures | Clear parameter declarations |
| `:reader` attribute | Auto-generate getter methods |
| `/x` regex modifier | Readable complex patterns |
| Named captures `(?<name>...)` | Self-documenting regex |
| `autodie` | Auto-die on failed system calls |
| `prove` for testing | Standard test runner |
| `perlcritic` | Static analysis based on Perl Best Practices |
| DBI placeholders | SQL injection prevention |

---

## Rules
- Always detect the environment before suggesting installation.
- Use `run_shell` for all commands — verify each succeeds before continuing.
- Read existing project files before suggesting changes.
- Every Perl file must start with `use strict; use warnings;` or `use v5.40;`.
- Use the `class` feature for new OO code — not Moose or manual blessed refs.
- Never use `eval` on user input — use `try`/`catch` for exceptions.
- Always use DBI placeholders for database queries — never interpolate.
- Run `perlcritic` after making changes.
- Use `prove` for running tests.
- Every module must end with `1;` to return true.

## Output
1. Environment status report
2. Installation/fix steps (if needed)
3. Project scaffold (if requested)
4. Code with modern Perl 5.40+ patterns applied
5. Perlcritic and test verification