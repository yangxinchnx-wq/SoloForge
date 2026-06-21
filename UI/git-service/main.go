package main

import (
	"flag"
	"log"
	"os"
	"path/filepath"

	"git-service/handler"
)

func main() {
	port := flag.String("port", "3002", "HTTP server port")
	repoPath := flag.String("repo", ".", "Path to git repository")
	flag.Parse()

	// Resolve absolute path
	abs, err := filepath.Abs(*repoPath)
	if err != nil {
		log.Fatalf("Invalid repo path: %v", err)
	}

	// Verify directory exists
	if info, err := os.Stat(abs); err != nil || !info.IsDir() {
		log.Fatalf("Repo path does not exist or is not a directory: %s", abs)
	}

	log.Printf("[git-service] go-git backend starting...")
	log.Printf("[git-service] Repo: %s", abs)
	log.Printf("[git-service] Port: %s", *port)

	if err := handler.StartServer(*port, abs); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
