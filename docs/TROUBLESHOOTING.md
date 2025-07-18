# Troubleshooting Guide

Common issues and solutions for whisper-wrap deployment and operation.

## Quick Diagnostics

Start with these basic checks:

```bash
# Check system dependencies
make check-system-deps

# Test API health
curl http://localhost:8000/health

# Check services are running
make dev  # Should start both services
```

## Common Issues

### whisper-server Connection Failed

**Symptoms**: API returns 500 errors, health check shows `whisper_server: false`

**Solutions**:
- Verify whisper-server is running on configured port
- Check `WHISPER_SERVER_URL` in configuration
- Ensure whisper-server is built: `make build-whisper`
- Try restarting whisper-server: `make run-whisper`

**Check whisper-server status**:
```bash
# Check if whisper-server is running
curl http://localhost:9000/health

# Check whisper-server logs
make run-whisper  # Run in separate terminal
```

### System Dependencies Missing

**Symptoms**: `make check-system-deps` shows missing dependencies

**Solutions**:
- Run `make install-system-deps` for automatic installation
- Or install manually (see below)

**Manual installation**:
```bash
# macOS
brew install ffmpeg libmagic

# Ubuntu/Debian
sudo apt-get install ffmpeg libmagic1 libmagic-dev

# RHEL/CentOS
sudo yum install ffmpeg file-devel

# Arch Linux
sudo pacman -S ffmpeg file
```

### ffmpeg Not Found

**Symptoms**: Audio conversion fails, `ffmpeg: command not found`

**Solutions**:
- Install ffmpeg system dependency
- Verify ffmpeg is in system PATH: `which ffmpeg`
- Add ffmpeg to PATH if installed in non-standard location

### libmagic Import Error

**Symptoms**: `ImportError: failed to find libmagic`

**Solutions**:
- Install libmagic system dependency
- Check with: `python3 -c "import magic"`
- On macOS: `brew install libmagic`
- On Ubuntu: `sudo apt-get install libmagic1 libmagic-dev`

### Performance Issues

**Symptoms**: Slow transcription, high resource usage

**Diagnosis**:
```bash
# Check available RAM
free -h  # Linux
vm_stat | grep "Pages free"  # macOS

# Check CPU usage during transcription
top -p $(pgrep whisper-server)

# Check disk space
df -h
```

**Solutions**:
- Ensure 4GB+ RAM available (whisper needs 2-4GB)
- Monitor CPU usage during transcription
- Verify disk space for temporary files
- Consider shorter audio files for testing
- Use faster storage (SSD recommended)

### Audio Quality Issues

**Symptoms**: Poor transcription accuracy, garbled text

**Solutions**:
- Ensure audio is clear with minimal background noise
- Check supported formats list
- Try converting to WAV format first
- Verify file isn't corrupted or empty
- Test with high-quality audio samples

**Audio preprocessing**:
```bash
# Convert to optimal format
ffmpeg -i input.mp3 -ar 16000 -ac 1 -c:a pcm_s16le output.wav

# Check audio properties
ffprobe input.mp3
```

### Docker Build Issues

**Symptoms**: Docker build fails, long build times

**Common causes and solutions**:
- **Long build time**: First build takes 10-15 minutes (normal)
- **Disk space**: Requires ~3GB disk space for final image
- **Memory**: Ensure Docker has sufficient memory (4GB+ recommended)
- **Download time**: Build includes downloading 1.5GB whisper model

**Docker-specific troubleshooting**:
```bash
# Check Docker resources
docker system info

# Clean up Docker
docker system prune -f

# Build with verbose output
docker build --no-cache -t whisper-wrap:latest .

# Check running containers
docker ps
```

### Architecture-Specific Issues

**ARM/Apple Silicon (M1/M2)**:
- **GPU Limitation**: Docker containers cannot access GPU acceleration
- **Performance**: Still excellent with CPU-only processing and NEON optimizations
- **Build time**: May take longer due to compilation

**x86_64 (Intel/AMD)**:
- **Optimizations**: Automatic AVX/AVX2 support
- **Performance**: Generally fastest transcription speeds

**Verification**:
```bash
# Check architecture
uname -m

# Verify Docker architecture
docker run --rm whisper-wrap:latest uname -m
```

### Port Configuration Issues

**Symptoms**: Services not accessible, port conflicts

**Solutions**:
- Check port configuration in `.env` file
- Verify ports are not in use: `lsof -i :8000`
- Ensure ports are in valid range (1-65535)
- Check firewall settings

**Port debugging**:
```bash
# Check what's using port 8000
lsof -i :8000

# Test port connectivity
curl -I http://localhost:8000/health

# Check Makefile port loading
make -n run  # Shows what ports would be used
```

## Error Code Reference

### HTTP Error Codes

- **400 Bad Request**: Malformed request, check request format
- **413 Payload Too Large**: File exceeds `MAX_FILE_SIZE_MB` limit
- **415 Unsupported Media Type**: File format not supported
- **422 Unprocessable Entity**: Missing file or invalid filename
- **500 Internal Server Error**: Server error, check logs

### Service-Specific Errors

**whisper-server errors**:
- Connection refused → whisper-server not running
- Timeout → whisper-server overloaded or crashed
- Model not found → Run `make download-model`

**ffmpeg errors**:
- Command not found → Install ffmpeg
- Conversion failed → Check input file format
- Permission denied → Check file permissions

## Debugging Tools

### Enable Debug Logging

```bash
# Set debug level in .env
echo "LOG_LEVEL=DEBUG" >> .env

# Restart services
make dev
```

### Check Logs

```bash
# Watch API logs
make run  # Shows FastAPI logs

# Watch whisper-server logs
make run-whisper  # Shows whisper-server logs
```

### Test with Simple Files

```bash
# Test with a simple audio file
curl -X POST "http://localhost:8000/transcribe" \
     -F "file=@test.wav"

# Test health endpoint
curl http://localhost:8000/health
```

## Performance Monitoring

### Resource Usage

```bash
# Monitor memory usage
watch -n 1 'free -h'

# Monitor CPU usage
htop

# Monitor disk usage
df -h
watch -n 1 'du -sh /tmp/whisper-wrap'
```

### Benchmarking

```bash
# Test transcription speed
time curl -X POST "http://localhost:8000/transcribe" \
     -F "file=@test-1min.mp3"

# Test multiple concurrent requests
for i in {1..5}; do
  curl -X POST "http://localhost:8000/transcribe" \
       -F "file=@test.mp3" &
done
wait
```

## Getting Help

If issues persist:

1. **Check Documentation**: Review [Installation](INSTALLATION.md) and [API](API.md) guides
2. **Search Issues**: Look for similar issues in the project repository
3. **Gather Information**: Include system info, error messages, and logs
4. **Test Minimal Case**: Try with simple audio files first
5. **Environment Details**: Include OS, architecture, and dependency versions

### Useful Information to Include

```bash
# System information
uname -a
python3 --version
ffmpeg -version
cmake --version

# Service status
curl -s http://localhost:8000/health | jq
make check-system-deps

# Resource usage
free -h
df -h
```