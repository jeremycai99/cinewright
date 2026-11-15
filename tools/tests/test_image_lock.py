from cinewright_tools.image_lock import check_image_lock, stale_lock_notice


def test_unpublished_lock_is_allowed() -> None:
    assert check_image_lock({"digest": None, "inputs_hash": None}, None, "h1") == []


def test_lock_matches_label_and_tree() -> None:
    assert check_image_lock({"digest": "sha256:a", "inputs_hash": "h1"}, "h1", "h1") == []


def test_label_mismatch() -> None:
    assert check_image_lock({"digest": "sha256:a", "inputs_hash": "h1"}, "h2", "h1") == [
        "image sha256:a was built from inputs h2, lock says h1"
    ]


def test_stale_lock_is_not_a_problem() -> None:
    # A PR that changes a container input cannot publish; the image is published after merge.
    assert check_image_lock({"digest": "sha256:a", "inputs_hash": "h1"}, "h1", "h3") == []


def test_stale_lock_notice() -> None:
    assert stale_lock_notice({"digest": "sha256:a", "inputs_hash": "h1"}, "h3") == (
        "container inputs changed (h3) since the locked image (h1): "
        "publish and update container/image.lock.json"
    )


def test_no_notice_when_current_or_unpublished() -> None:
    assert stale_lock_notice({"digest": "sha256:a", "inputs_hash": "h1"}, "h1") is None
    assert stale_lock_notice({"digest": None, "inputs_hash": None}, "h1") is None


def test_half_set_lock_is_rejected() -> None:
    assert check_image_lock({"digest": "sha256:a", "inputs_hash": None}, None, "h1") == [
        "container/image.lock.json must set both digest and inputs_hash, or neither"
    ]
