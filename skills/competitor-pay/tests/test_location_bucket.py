"""Tests for location bucketing."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from location_bucket import bucket_location, to_sharepoint_location


class TestSBCounty:
    def test_santa_barbara(self):
        assert bucket_location("Santa Barbara, CA") == "Santa Barbara County"

    def test_goleta(self):
        assert bucket_location("Goleta, CA") == "Santa Barbara County"

    def test_lompoc(self):
        assert bucket_location("Lompoc, CA 93436") == "Santa Barbara County"

    def test_santa_maria(self):
        assert bucket_location("Santa Maria, CA") == "Santa Barbara County"

    def test_carpinteria(self):
        assert bucket_location("Carpinteria, CA") == "Santa Barbara County"

    def test_montecito(self):
        assert bucket_location("Montecito, CA 93108") == "Santa Barbara County"

    def test_sb_zip(self):
        assert bucket_location("93101") == "Santa Barbara County"

    def test_hybrid_sb(self):
        """Hybrid remote in SB should be SB County, not Remote."""
        assert bucket_location("Hybrid remote in Santa Barbara, CA") == "Santa Barbara County"


class TestVenturaCounty:
    def test_ventura_city(self):
        assert bucket_location("Ventura, CA") == "Ventura County"

    def test_oxnard(self):
        assert bucket_location("Oxnard, CA") == "Ventura County"

    def test_thousand_oaks(self):
        assert bucket_location("Thousand Oaks, CA") == "Ventura County"

    def test_simi_valley(self):
        assert bucket_location("Simi Valley, CA") == "Ventura County"

    def test_camarillo(self):
        assert bucket_location("Camarillo, CA") == "Ventura County"

    def test_ojai(self):
        assert bucket_location("Ojai, CA") == "Ventura County"

    def test_ventura_zip(self):
        assert bucket_location("93003") == "Ventura County"

    def test_oxnard_zip(self):
        assert bucket_location("93030") == "Ventura County"

    def test_thousand_oaks_zip(self):
        assert bucket_location("91320") == "Ventura County"

    def test_hybrid_ventura(self):
        """Hybrid remote in Ventura should be Ventura County, not Remote."""
        assert bucket_location("Hybrid remote in Oxnard, CA") == "Ventura County"

    def test_sb_zip_not_ventura(self):
        """931xx should be SB County, not Ventura."""
        assert bucket_location("93101") == "Santa Barbara County"
        assert bucket_location("93436") == "Santa Barbara County"


class TestRemote:
    def test_remote(self):
        assert bucket_location("Remote") == "Remote"

    def test_work_from_home(self):
        assert bucket_location("Work from home") == "Remote"

    def test_fully_remote(self):
        assert bucket_location("Fully Remote") == "Remote"

    def test_united_states(self):
        assert bucket_location("United States") == "Remote"

    def test_anywhere(self):
        assert bucket_location("Anywhere") == "Remote"


class TestOtherCA:
    def test_los_angeles(self):
        assert bucket_location("Los Angeles, CA") == "Other California"

    def test_san_francisco(self):
        assert bucket_location("San Francisco, CA") == "Other California"

    def test_sacramento(self):
        assert bucket_location("Sacramento, CA 95814") == "Other California"

    def test_california_state(self):
        assert bucket_location("California") == "Other California"


class TestOutOfState:
    def test_portland(self):
        assert bucket_location("Portland, OR") == "Out of State"

    def test_new_york(self):
        assert bucket_location("New York, NY") == "Out of State"

    def test_texas(self):
        assert bucket_location("Austin, TX") == "Out of State"


class TestUnknown:
    def test_empty(self):
        assert bucket_location("") == "Unknown"

    def test_none(self):
        assert bucket_location(None) == "Unknown"

    def test_gibberish(self):
        assert bucket_location("multiple locations") == "Unknown"


class TestSharePointMapping:
    def test_sb_county_maps(self):
        assert to_sharepoint_location("Santa Barbara County") == "SB County"

    def test_ventura_maps(self):
        assert to_sharepoint_location("Ventura County") == "Ventura County"

    def test_other_ca_maps(self):
        assert to_sharepoint_location("Other California") == "Other CA"

    def test_remote_skipped(self):
        assert to_sharepoint_location("Remote") is None

    def test_out_of_state_skipped(self):
        assert to_sharepoint_location("Out of State") is None

    def test_unknown_skipped(self):
        assert to_sharepoint_location("Unknown") is None
