<?php

declare(strict_types=1);

namespace App;

enum UserRole: string
{
    case Admin = 'admin';
    case Developer = 'developer';
    case User = 'user';
}

readonly class UserRecord
{
    public function __construct(
        public string $id,
        public string $email,
        public UserRole $role,
        public float $score = 0.0
    ) {}
}

interface UserProcessorInterface
{
    public function process(UserRecord $user): array;
}

final class CoreUserProcessor implements UserProcessorInterface
{
    public function __construct(
        private string $engineName
    ) {}

    public function process(UserRecord $user): array
    {
        $adjustedScore = match ($user->role) {
            UserRole::Admin => $user->score * 1.5,
            UserRole::Developer => $user->score * 1.25,
            UserRole::User => $user->score,
        };

        return [
            'status' => 'processed',
            'engine' => $this->engineName,
            'user_id' => $user->id,
            'original_score' => $user->score,
            'adjusted_score' => round($adjustedScore, 2),
            'timestamp' => (new \DateTimeImmutable())->format(\DateTimeInterface::ATOM)
        ];
    }
}

// Execution Entry
$processor = new CoreUserProcessor('Php83CoreEngine');
$user = new UserRecord('usr_4401', 'php.dev@example.com', UserRole::Developer, 100.0);

$result = $processor->process($user);

header('Content-Type: application/json');
echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
