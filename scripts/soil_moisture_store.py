# /// script
# requires-python = ">=3.12"
# dependencies = ["xarray>=2025.1", "netcdf4>=1.7", "zarr>=3.0", "numpy>=2.0"]
# ///
"""
Build the soil moisture store that imputation reads its features from.

The source is NOAA CPC Soil Moisture v2: a monthly 0.5 degree grid from January
1948, about a month behind the present. It is the record the imputation
notebook was trained against, and its length is the reason for using it rather
than the GLDAS anomalies in the GRACE stores: the pipeline builds a ten-year
rolling mean and discards the first ten years, so a record starting in 2002
would leave nothing before 2012.

Values are kept as published, in mm, rather than as anomalies. Every feature
is z-scored before training, so either would work, but keeping the absolute
values means the features match the THREDDS series the pipeline used to read.

The layout is tuned for the one read the app makes: the whole record at one
cell. Each chunk is every month for a 10 x 10 block of cells, about 380 kB
before compression, and chunks that are entirely ocean are not written at all,
which the app reads as missing.

Usage:
    curl -o soilw.mon.mean.v2.nc https://downloads.psl.noaa.gov/Datasets/cpcsoil/soilw.mon.mean.v2.nc
    uv run scripts/soil_moisture_store.py soilw.mon.mean.v2.nc ~/data/aquiferx/zarrs
"""

import sys
from pathlib import Path

import numpy as np
import xarray as xr
from zarr.codecs import ZstdCodec

NAME = "cpc-soil-moisture-0.5"
CHUNK_CELLS = 10


def main(src: Path, out_root: Path) -> None:
    ds = xr.open_dataset(src)
    soilw = ds["soilw"]

    # 0..360 longitudes become -180..180, and latitude runs south to north, so
    # both coordinates ascend and a cell's index is arithmetic on its bounds.
    soilw = soilw.assign_coords(lon=((soilw.lon + 180) % 360) - 180).sortby("lon").sortby("lat")

    times = soilw.time.values.astype("datetime64[D]")
    epoch = np.datetime64("1948-01-01", "D")

    out = xr.Dataset(
        {"soilw": (("time", "lat", "lon"), soilw.values.astype("float32"))},
        coords={
            "time": ("time", (times - epoch).astype("int32")),
            "lat": ("lat", soilw.lat.values.astype("float32")),
            "lon": ("lon", soilw.lon.values.astype("float32")),
        },
        attrs={
            "title": "CPC Soil Moisture v2, monthly",
            "source": "NOAA PSL, https://psl.noaa.gov/data/gridded/data.cpcsoil.html",
            "resolution_degrees": 0.5,
            "first_month": str(times[0]),
            "last_month": str(times[-1]),
        },
    )
    out["soilw"].attrs = {"units": "mm", "long_name": "Model-calculated monthly mean soil moisture"}
    out["time"].attrs = {"units": "days since 1948-01-01", "calendar": "proleptic_gregorian"}
    out["lat"].attrs = {"units": "degrees_north", "long_name": "latitude of cell center"}
    out["lon"].attrs = {"units": "degrees_east", "long_name": "longitude of cell center"}

    n_time = out.sizes["time"]
    dest = out_root / f"{NAME}.zarr"
    out.to_zarr(
        dest,
        mode="w",
        zarr_format=3,
        consolidated=True,
        encoding={
            "soilw": {
                "chunks": (n_time, CHUNK_CELLS, CHUNK_CELLS),
                "compressors": ZstdCodec(level=9),
                "fill_value": np.float32("nan"),
            },
            "time": {"chunks": (n_time,)},
            "lat": {"chunks": (out.sizes["lat"],)},
            "lon": {"chunks": (out.sizes["lon"],)},
        },
        write_empty_chunks=False,
    )
    print(f"Wrote {dest}: {n_time} months, {times[0]} to {times[-1]}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(Path(sys.argv[1]).expanduser(), Path(sys.argv[2]).expanduser())
