import tempfile
from pathlib import Path

import pytest

from app.config import config
from app.services.files import FileManager


@pytest.fixture
def file_manager():
    """Create a file manager for testing."""
    with tempfile.TemporaryDirectory() as temp_dir:
        original_temp_dir = config.TEMP_DIR
        config.TEMP_DIR = Path(temp_dir)
        manager = FileManager()
        yield manager
        config.TEMP_DIR = original_temp_dir


def test_create_temp_file(file_manager):
    """Test temporary file creation."""
    temp_file = file_manager.create_temp_file(suffix=".test")

    assert temp_file.suffix == ".test"
    assert temp_file.parent == config.TEMP_DIR


def test_validate_file_size(file_manager):
    """Test file size validation."""
    # Create a small test file
    test_file = file_manager.create_temp_file()
    test_file.write_text("test content")

    # Should pass validation
    assert file_manager.validate_file_size(test_file)

    # Test with size limit
    original_size = config.MAX_FILE_SIZE_MB
    config.MAX_FILE_SIZE_MB = 0.000001  # Very small limit
    assert not file_manager.validate_file_size(test_file)
    config.MAX_FILE_SIZE_MB = original_size


def test_cleanup_file(file_manager):
    """Test file cleanup."""
    test_file = file_manager.create_temp_file()
    test_file.write_text("test content")

    assert test_file.exists()
    file_manager.cleanup_file(test_file)
    assert not test_file.exists()


def test_cleanup_nonexistent_file(file_manager):
    """Test cleanup of non-existent file doesn't raise error."""
    nonexistent = Path("/nonexistent/file.txt")
    # Should not raise an exception
    file_manager.cleanup_file(nonexistent)
