"""
Production Python Starter Architecture
Demonstrating Pydantic v2 validation, async execution, structured logging, and clean error handling.
"""

import asyncio
import logging
from typing import Optional
from pydantic import BaseModel, Field, EmailStr, ConfigDict

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("python-starter")

class UserRecord(BaseModel):
    model_config = ConfigDict(frozen=True)
    
    user_id: str = Field(..., description="Unique user identifier")
    email: EmailStr = Field(..., description="User primary email address")
    active: bool = Field(default=True)
    score: float = Field(default=0.0, ge=0.0)

class DataProcessor:
    def __init__(self, service_name: str) -> None:
        self.service_name = service_name

    async def process_user(self, user: UserRecord) -> dict[str, str | float]:
        logger.info(f"[{self.service_name}] Processing user: {user.user_id}")
        await asyncio.sleep(0.05)  # Simulated async IO
        
        calculated_tier = "premium" if user.score >= 100.0 else "standard"
        return {
            "status": "processed",
            "user_id": user.user_id,
            "tier": calculated_tier,
            "processed_score": user.score * 1.1
        }

async def main() -> None:
    processor = DataProcessor(service_name="CoreUserEngine")
    user = UserRecord(user_id="usr_1001", email="dev@example.com", score=120.5)
    
    result = await processor.process_user(user)
    logger.info(f"Execution Output: {result}")

if __name__ == "__main__":
    asyncio.run(main())
