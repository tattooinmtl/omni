import { z } from 'zod';

export const UserSchema = z.object({
  id: z.string().min(3),
  email: z.string().email(),
  role: z.enum(['admin', 'developer', 'viewer']),
  score: z.number().min(0).default(0)
});

export type User = z.infer<typeof UserSchema>;

export type AsyncResult<T> = 
  | { success: true; data: T; timestamp: string }
  | { success: false; error: string; timestamp: string };

export class TypeScriptEngine {
  constructor(private readonly serviceName: string) {}

  public async processUser(input: unknown): Promise<AsyncResult<User>> {
    const parseResult = UserSchema.safeParse(input);

    if (!parseResult.success) {
      return {
        success: false,
        error: `Validation Failed: ${parseResult.error.message}`,
        timestamp: new Date().toISOString()
      };
    }

    const user = parseResult.data;
    await new Promise(res => setTimeout(res, 50)); // Simulated IO

    const updatedUser: User = {
      ...user,
      score: user.score + 25
    };

    return {
      success: true,
      data: updatedUser,
      timestamp: new Date().toISOString()
    };
  }
}

async function runExample() {
  const engine = new TypeScriptEngine('TsCoreEngine');
  const payload = {
    id: 'usr_7712',
    email: 'typescript@example.com',
    role: 'developer',
    score: 100
  };

  const response = await engine.processUser(payload);
  if (response.success) {
    console.log('[TypeScript Verified Result]:', response.data);
  } else {
    console.error('[TypeScript Error]:', response.error);
  }
}

runExample();
