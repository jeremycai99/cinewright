from cinewright_stt_whisperx.normalize import spoken_form, spoken_tokens


def test_numerals_and_symbols_are_spoken() -> None:
    assert spoken_form("2014") == "twenty fourteen"
    assert spoken_form("£13.60,") == "thirteen pounds and sixty pence"
    assert spoken_form("$1") == "one dollar"
    assert spoken_form("€2.01") == "two euros and one cent"
    assert spoken_form("42") == "forty-two"
    assert spoken_form("3.5") == "three point five"
    assert spoken_form("1,200") == "one thousand, two hundred"
    assert spoken_form("15%") == "fifteen percent"
    assert spoken_form("7th") == "seventh"
    assert spoken_form("&") == "and"


def test_ordinary_words_are_unchanged() -> None:
    for word in ("bridge", "later.", "it's", "Kubernetes"):
        assert spoken_form(word) == word


def test_given_spoken_forms_win() -> None:
    assert spoken_tokens(["In", "2014"], ["in", "twenty fourteen"]) == [
        ["in"],
        ["twenty", "fourteen"],
    ]
    assert spoken_tokens(["In", "2014"], None) == [["In"], ["twenty", "fourteen"]]
