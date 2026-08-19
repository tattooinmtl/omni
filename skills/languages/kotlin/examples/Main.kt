package com.example.app

import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Serializable
data class ProcessTask(
    val taskId: String,
    val payload: String,
    val priority: Int = 1
)

sealed interface TaskResult {
    data class Success(val taskId: String, val message: String) : TaskResult
    data class Failure(val taskId: String, val error: String) : TaskResult
}

class TaskEngine(private val serviceName: String) {
    suspend fun executeTask(task: ProcessTask): TaskResult = coroutineScope {
        delay(50) // Async processing simulation
        if (task.payload.isNotBlank()) {
            TaskResult.Success(task.taskId, "Processed by $serviceName with priority ${task.priority}")
        } else {
            TaskResult.Failure(task.taskId, "Payload cannot be blank")
        }
    }

    fun observeTaskStream(): Flow<Int> = flow {
        for (i in 1..3) {
            delay(30)
            emit(i * 10)
        }
    }
}

fun main() = runBlocking {
    val jsonFormat = Json { prettyPrint = true }
    val engine = TaskEngine("KotlinCoreEngine")

    val sampleTask = ProcessTask(taskId = "tsk_9901", payload = "Active Pipeline Event", priority = 5)
    println("Serialized Task:\n${jsonFormat.encodeToString(sampleTask)}")

    val result = engine.executeTask(sampleTask)
    when (result) {
        is TaskResult.Success -> println("Result: SUCCESS -> ${result.message}")
        is TaskResult.Failure -> println("Result: FAILURE -> ${result.error}")
    }
}
