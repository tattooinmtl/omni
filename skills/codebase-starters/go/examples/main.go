package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"time"
)

type ProcessRequest struct {
	ID      string  `json:"id"`
	Payload string  `json:"payload"`
	Score   float64 `json:"score"`
}

type ProcessResponse struct {
	ID             string    `json:"id"`
	Status         string    `json:"status"`
	ProcessedScore float64   `json:"processed_score"`
	Timestamp      time.Time `json:"timestamp"`
}

type Processor interface {
	Process(ctx context.Context, req ProcessRequest) (*ProcessResponse, error)
}

type Engine struct {
	name string
}

func NewEngine(name string) *Engine {
	return &Engine{name: name}
}

func (e *Engine) Process(ctx context.Context, req ProcessRequest) (*ProcessResponse, error) {
	if req.ID == "" {
		return nil, errors.New("request ID cannot be empty")
	}

	select {
	case <-time.After(50 * time.Millisecond): // Simulated work
	case <-ctx.Done():
		return nil, fmt.Errorf("process cancelled: %w", ctx.Err())
	}

	res := &ProcessResponse{
		ID:             req.ID,
		Status:         fmt.Sprintf("PROCESSED_BY_%s", e.name),
		ProcessedScore: req.Score * 1.1,
		Timestamp:      time.Now().UTC(),
	}

	return res, nil
}

func main() {
	log.Println("=== Go 1.22+ Production Microservice Starter ===")

	engine := NewEngine("GoCoreEngine")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	req := ProcessRequest{
		ID:      "req_1044",
		Payload: "Goroutine Concurrency Event",
		Score:   95.0,
	}

	resp, err := engine.Process(ctx, req)
	if err != nil {
		log.Fatalf("Error processing request: %v", err)
	}

	out, err := json.MarshalIndent(resp, "", "  ")
	if err != nil {
		log.Fatalf("Error marshaling JSON: %v", err)
	}

	fmt.Printf("Verified Output:\n%s\n", string(out))
}
