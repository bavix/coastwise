package main

import (
	"cmp"
	"compress/gzip"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/bavix/spatial"
	"github.com/bavix/spatial/coast"
	"github.com/bavix/spatial/geo"
	"github.com/bavix/spatial/region"
)

//go:embed third_party/*.json.gz web
var assets embed.FS

type Sea struct {
	ID       string          `json:"id"`
	Name     string          `json:"name"`
	Geometry json.RawMessage `json:"geometry"`
	Coast    [][][]float64   `json:"coast,omitempty"`
	shore    *coast.Index
}

type Dataset struct {
	Seas []Sea `json:"seas"`
}

type App struct {
	hotels     []HotelPoint
	stats      Stats
	index      *spatial.Index
	seas       []Sea
	water      *region.Index
	islands    *region.Index
	started    time.Time
	startupMS  float64
	indexBytes uint64
}

type Query struct {
	West     float64 `json:"west"`
	South    float64 `json:"south"`
	East     float64 `json:"east"`
	North    float64 `json:"north"`
	Width    int     `json:"width"`
	Height   int     `json:"height"`
	Sea      string  `json:"sea"`
	Search   string  `json:"search"`
	RealOnly bool    `json:"realOnly"`
}

type Distance struct {
	SeaID      string    `json:"seaId"`
	Meters     float64   `json:"meters"`
	Shore      geo.Point `json:"shore"`
	ErrorBound float64   `json:"errorBoundMeters"`
}

type HotelPoint struct {
	Name     string  `json:"name,omitempty"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
	Sea      uint8   `json:"sea"`
	Source   string  `json:"source,omitempty"`
	SourceID string  `json:"sourceId,omitempty"`
}

type Stats struct {
	Count          int         `json:"count"`
	RealCount      int         `json:"realCount"`
	GeneratedCount int         `json:"generatedCount"`
	Seas           []SeaStats  `json:"seas"`
	Server         ServerStats `json:"server"`
}

type ServerStats struct {
	Platform      string  `json:"platform"`
	GoVersion     string  `json:"goVersion"`
	UptimeSeconds float64 `json:"uptimeSeconds"`
	StartupMS     float64 `json:"startupMs"`
	HeapBytes     uint64  `json:"heapBytes"`
	IndexBytes    uint64  `json:"indexBytes"`
	Goroutines    int     `json:"goroutines"`
	CPUs          int     `json:"cpus"`
	CoastSegments int     `json:"coastSegments"`
}

type SeaStats struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type Hotel struct {
	Source    string     `json:"source,omitempty"`
	SourceID  string     `json:"sourceId,omitempty"`
	ID        uint64     `json:"id"`
	Name      string     `json:"name"`
	SeaID     string     `json:"seaId"`
	Lat       float64    `json:"lat"`
	Lon       float64    `json:"lon"`
	Distances []Distance `json:"distances"`
	Nearby    int        `json:"nearby"`
	OnLand    bool       `json:"onLand"`
}

type Cell struct {
	Name     string   `json:"name"`
	Source   string   `json:"source"`
	ID       uint64   `json:"id"`
	Count    int      `json:"count"`
	Lat      float64  `json:"lat"`
	Lon      float64  `json:"lon"`
	West     float64  `json:"west"`
	South    float64  `json:"south"`
	East     float64  `json:"east"`
	North    float64  `json:"north"`
	Distance Distance `json:"distance"`
}

type Result struct {
	Visible    int     `json:"visible"`
	Cells      []Cell  `json:"cells"`
	QueryMS    float64 `json:"queryMs"`
	DistanceMS float64 `json:"distanceMs"`
	IndexBytes uint64  `json:"indexBytes"`
}

func main() {
	started := time.Now()
	log.Printf("Starting Coastwise: %s, %s/%s", runtime.Version(), runtime.GOOS, runtime.GOARCH)
	httpHandler, err := handler()
	if err != nil {
		log.Fatal(err)
	}

	addr := os.Getenv("ADDR")
	if addr == "" {
		port := os.Getenv("PORT")
		if port == "" {
			port = "8080"
		}

		addr = "127.0.0.1:" + port
	}

	server := &http.Server{
		Addr:              addr,
		Handler:           httpHandler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	log.Printf("Starting HTTP server on %s...", addr)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatal(err)
	}

	log.Printf("Ready: http://%s (startup %s)", addr, time.Since(started).Round(time.Millisecond))
	if err := server.Serve(listener); err != nil {
		log.Fatal(err)
	}
}

func readDataset(name string) ([]byte, error) {
	file, err := assets.Open("third_party/" + name + ".json.gz")
	if err != nil {
		return nil, err
	}

	defer file.Close()

	reader, err := gzip.NewReader(file)
	if err != nil {
		return nil, err
	}

	defer reader.Close()

	return io.ReadAll(reader)
}

func handler() (http.Handler, error) {
	started := time.Now()
	log.Print("Loading embedded datasets...")
	hotelData, err := readDataset("hotels")
	if err != nil {
		return nil, err
	}

	seaData, err := readDataset("seas")
	if err != nil {
		return nil, err
	}

	log.Printf(
		"Embedded datasets loaded: hotels %.2f MiB, seas %.2f MiB in %s",
		float64(len(hotelData))/(1<<20),
		float64(len(seaData))/(1<<20),
		time.Since(started).Round(time.Millisecond),
	)
	app, err := loadSpatial(hotelData, seaData)
	if err != nil {
		return nil, err
	}

	web, err := fs.Sub(assets, "web")
	if err != nil {
		return nil, err
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/stats", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, app.Stats())
	})
	mux.HandleFunc("GET /api/seas", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, app.seas)
	})
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"status": "ok", "hotels": len(app.hotels)})
	})
	mux.HandleFunc("POST /api/viewport", app.serveViewport)
	mux.HandleFunc("GET /api/hotels/{id}", app.serveHotel)
	mux.HandleFunc("GET /api/nearest", app.serveNearest)
	mux.HandleFunc("GET /api/", http.NotFound)
	mux.Handle("/", http.FileServer(http.FS(web)))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		mux.ServeHTTP(w, r)
	}), nil
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("Response interrupted: %v", err)
	}
}

func loadSpatial(hotelsJSON, seasJSON []byte) (*App, error) {
	started := time.Now()
	stage := time.Now()
	log.Print("Decoding hotel records...")
	var hotels []HotelPoint
	if err := json.Unmarshal(hotelsJSON, &hotels); err != nil {
		return nil, err
	}

	log.Printf("Hotels decoded: %d records in %s", len(hotels), time.Since(stage).Round(time.Millisecond))

	stage = time.Now()
	log.Print("Decoding sea geometry...")
	app := &App{
		hotels:  hotels,
		started: started,
		stats:   Stats{Count: len(hotels)},
	}

	var dataset Dataset
	if err := json.Unmarshal(seasJSON, &dataset); err != nil {
		return nil, fmt.Errorf("sea data: %w", err)
	}

	app.seas = dataset.Seas
	log.Printf("Sea geometry decoded: %d seas in %s", len(app.seas), time.Since(stage).Round(time.Millisecond))
	for i := range app.seas {
		s := &app.seas[i]
		stage = time.Now()
		log.Printf("Building %s coastline index...", s.Name)

		lines := make([]geo.Polyline, 0, len(s.Coast))
		for _, line := range s.Coast {
			p := make(geo.Polyline, len(line))
			for j, c := range line {
				p[j] = geo.P(c[1], c[0])
			}

			lines = append(lines, p)
		}

		var err error
		s.shore, err = coast.Build(lines)
		if err != nil {
			return nil, fmt.Errorf("%s coastline: %w", s.ID, err)
		}

		log.Printf("%s coastline indexed: %d segments in %s", s.Name, s.shore.Len(), time.Since(stage).Round(time.Millisecond))
	}

	stage = time.Now()
	log.Print("Preparing water and island polygons...")
	water, islands, err := seaRegions(app.seas)
	if err != nil {
		return nil, err
	}

	log.Printf("Polygons prepared: %d water areas, %d islands in %s", len(water), len(islands), time.Since(stage).Round(time.Millisecond))

	stage = time.Now()
	log.Print("Building water region index...")
	app.water, err = region.Build(water)
	if err != nil {
		return nil, err
	}

	log.Printf("Water regions indexed: %d polygons in %s", len(water), time.Since(stage).Round(time.Millisecond))

	stage = time.Now()
	log.Print("Building island region index...")
	app.islands, err = region.Build(islands)
	if err != nil {
		return nil, err
	}

	log.Printf("Island regions indexed: %d polygons in %s", len(islands), time.Since(stage).Round(time.Millisecond))

	stage = time.Now()
	log.Print("Building hotel spatial index...")
	items := make(spatial.Items, len(hotels))
	for i, h := range hotels {
		p := geo.P(h.Lat, h.Lon)
		items[i] = spatial.Item{ID: uint64(i + 1), Point: p}
	}

	app.index, err = spatial.Build(items, spatial.WithE7Coordinates(), spatial.WithWGS84())
	if err != nil {
		return nil, err
	}

	log.Printf("Hotels indexed: %d points in %s", len(hotels), time.Since(stage).Round(time.Microsecond))
	app.stats.Seas = make([]SeaStats, len(app.seas))
	for i, sea := range app.seas {
		app.stats.Seas[i] = SeaStats{ID: sea.ID, Name: sea.Name}
	}

	for _, hotel := range hotels {
		app.stats.Seas[hotel.Sea].Count++

		if hotel.Source == "Generated" {
			app.stats.GeneratedCount++
		} else {
			app.stats.RealCount++
		}
	}

	app.indexBytes = app.index.StorageBytes() + app.water.StorageBytes() + app.islands.StorageBytes()
	for _, s := range app.seas {
		app.indexBytes += s.shore.StorageBytes()
	}

	app.startupMS = float64(time.Since(started).Microseconds()) / 1000
	log.Printf(
		"Spatial data ready: %d hotels, %d seas, %.2f MiB of indexes in %s",
		len(hotels),
		len(app.seas),
		float64(app.indexBytes)/(1<<20),
		time.Since(started).Round(time.Millisecond),
	)

	return app, nil
}

func mercator(lat float64) float64 {
	return math.Log(math.Tan(math.Pi/4 + lat*math.Pi/360))
}

func (app *App) Viewport(q Query) (Result, error) {
	bounds := geo.Bounds{West: q.West, South: q.South, East: q.East, North: q.North}
	if !bounds.Valid() || q.West >= q.East || q.South >= q.North ||
		q.South < -85 || q.North > 85 || q.Width < 1 || q.Height < 1 {
		return Result{}, fmt.Errorf("invalid viewport")
	}

	sea := -1
	if q.Sea != "" {
		for i, s := range app.seas {
			if q.Sea == s.ID {
				sea = i
			}
		}

		if sea < 0 {
			return Result{}, fmt.Errorf("unknown sea")
		}
	}

	cols := max(1, min(20, q.Width/90))
	rows := max(1, min(12, q.Height/90))
	cells := make([]Cell, cols*rows)
	visible := 0
	start := time.Now()
	southY, northY := mercator(q.South), mercator(q.North)
	searcher := app.index.NewSearcher()
	query := strings.ToLower(strings.TrimSpace(q.Search))
	filter := func(item spatial.Item) bool {
		hotel := app.hotels[item.ID-1]
		if sea >= 0 && int(hotel.Sea) != sea {
			return false
		}

		if q.RealOnly && hotel.Source == "Generated" {
			return false
		}

		return query == "" || strings.Contains(strings.ToLower(app.hotelName(item.ID)), query)
	}

	for item := range searcher.Bounds(spatial.BoundsQuery{Bounds: bounds, Filter: filter}) {
		p := item.Point
		x := min(cols-1, max(0, int((p.Lon-q.West)/(q.East-q.West)*float64(cols))))
		y := min(rows-1, max(0, int((mercator(p.Lat)-southY)/(northY-southY)*float64(rows))))
		cell := &cells[y*cols+x]
		visible++
		if cell.Count == 0 {
			*cell = Cell{
				ID:    item.ID,
				Lat:   p.Lat,
				Lon:   p.Lon,
				West:  p.Lon,
				East:  p.Lon,
				South: p.Lat,
				North: p.Lat,
			}
		}

		cell.Count++
		cell.West = min(cell.West, p.Lon)
		cell.East = max(cell.East, p.Lon)
		cell.South = min(cell.South, p.Lat)
		cell.North = max(cell.North, p.Lat)
		if item.ID < cell.ID {
			cell.ID = item.ID
			cell.Lat = p.Lat
			cell.Lon = p.Lon
		}
	}

	result := Result{
		Visible:    visible,
		Cells:      make([]Cell, 0, len(cells)),
		QueryMS:    float64(time.Since(start).Microseconds()) / 1000,
		IndexBytes: app.indexBytes,
	}

	start = time.Now()
	shoreSearchers := make([]*coast.Searcher, len(app.seas))
	for i, s := range app.seas {
		shoreSearchers[i] = s.shore.NewSearcher()
	}

	for _, c := range cells {
		if c.Count == 0 {
			continue
		}

		s := int(app.hotels[c.ID-1].Sea)
		d, err := shoreSearchers[s].Nearest(geo.P(c.Lat, c.Lon), 0.5)
		if err != nil {
			return Result{}, err
		}

		c.Name = app.hotelName(c.ID)
		c.Source = app.hotels[c.ID-1].Source
		c.Distance = Distance{
			SeaID:      app.seas[s].ID,
			Meters:     d.Distance,
			Shore:      d.Point,
			ErrorBound: d.ErrorBound,
		}

		result.Cells = append(result.Cells, c)
	}

	result.DistanceMS = float64(time.Since(start).Microseconds()) / 1000
	slices.SortFunc(result.Cells, func(a, b Cell) int {
		return cmp.Compare(a.Distance.Meters, b.Distance.Meters)
	})
	return result, nil
}

func (app *App) Hotel(id uint64) (Hotel, error) {
	if id == 0 || id > uint64(len(app.hotels)) {
		return Hotel{}, fmt.Errorf("unknown hotel")
	}

	record := app.hotels[id-1]
	p := geo.P(record.Lat, record.Lon)
	h := Hotel{
		ID:        id,
		Name:      app.hotelName(id),
		Source:    record.Source,
		SourceID:  record.SourceID,
		SeaID:     app.seas[record.Sea].ID,
		Lat:       p.Lat,
		Lon:       p.Lon,
		Distances: make([]Distance, 0, len(app.seas)),
	}

	for _, s := range app.seas {
		r, err := s.shore.Nearest(p, 0.5)
		if err != nil {
			return Hotel{}, err
		}

		h.Distances = append(h.Distances, Distance{SeaID: s.ID, Meters: r.Distance, Shore: r.Point, ErrorBound: r.ErrorBound})
	}

	h.OnLand = !region.Allows(p, app.water, app.islands)
	for item := range app.index.Within(p, 1000*geo.Meter) {
		if item.ID != id {
			h.Nearby++
		}
	}

	slices.SortFunc(h.Distances, func(a, b Distance) int {
		return cmp.Compare(a.Meters, b.Meters)
	})
	return h, nil
}

func (app *App) Nearest(lat, lon float64, seaID string, realOnly bool) (uint64, error) {
	p := geo.P(lat, lon)
	if !p.Valid() {
		return 0, fmt.Errorf("invalid point")
	}

	sea := -1
	for i, candidate := range app.seas {
		if seaID == candidate.ID {
			sea = i
		}
	}

	if seaID != "" && sea < 0 {
		return 0, fmt.Errorf("unknown sea")
	}

	results := app.index.NewSearcher().AppendNearest(nil, spatial.NearestQuery{
		Center: p,
		Limit:  1,
		Filter: func(item spatial.Item) bool {
			return (sea < 0 || int(app.hotels[item.ID-1].Sea) == sea) && (!realOnly || app.hotels[item.ID-1].Source != "Generated")
		},
	})
	if len(results) == 0 {
		return 0, fmt.Errorf("no hotel found")
	}

	return results[0].ID, nil
}

func (app *App) hotelName(id uint64) string {
	if name := app.hotels[id-1].Name; name != "" {
		return name
	}

	if app.hotels[id-1].Source == "Generated" {
		return fmt.Sprintf("Sample hotel #%06d", id)
	}

	return fmt.Sprintf("Hotel #%06d", id)
}

func (app *App) serveViewport(w http.ResponseWriter, r *http.Request) {
	var q Query
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&q); err != nil {
		http.Error(w, "invalid viewport request", http.StatusBadRequest)
		return
	}

	result, err := app.Viewport(q)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	writeJSON(w, result)
}

func (app *App) serveHotel(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseUint(r.PathValue("id"), 10, 64)
	if err != nil {
		http.Error(w, "invalid hotel ID", http.StatusBadRequest)
		return
	}

	hotel, err := app.Hotel(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	writeJSON(w, hotel)
}

func (app *App) serveNearest(w http.ResponseWriter, r *http.Request) {
	lat, latErr := strconv.ParseFloat(r.URL.Query().Get("lat"), 64)
	lon, lonErr := strconv.ParseFloat(r.URL.Query().Get("lon"), 64)
	if latErr != nil || lonErr != nil {
		http.Error(w, "invalid coordinates", http.StatusBadRequest)
		return
	}

	id, err := app.Nearest(lat, lon, r.URL.Query().Get("sea"), r.URL.Query().Get("realOnly") == "true")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	writeJSON(w, map[string]uint64{"id": id})
}

func (app *App) Stats() Stats {
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	stats := app.stats
	stats.Server = ServerStats{
		Platform:      runtime.GOOS + "/" + runtime.GOARCH,
		GoVersion:     runtime.Version(),
		UptimeSeconds: time.Since(app.started).Seconds(),
		StartupMS:     app.startupMS,
		HeapBytes:     memory.HeapAlloc,
		IndexBytes:    app.indexBytes,
		Goroutines:    runtime.NumGoroutine(),
		CPUs:          runtime.NumCPU(),
	}

	for _, s := range app.seas {
		stats.Server.CoastSegments += s.shore.Len()
	}

	return stats
}

func seaRegions(seas []Sea) ([]region.Item, []region.Item, error) {
	var water, islands []region.Item
	for _, s := range seas {
		var geometry struct {
			Coordinates [][][][]float64 `json:"coordinates"`
		}

		if err := json.Unmarshal(s.Geometry, &geometry); err != nil {
			return nil, nil, err
		}

		for _, polygon := range geometry.Coordinates {
			for i, coordinates := range polygon {
				ring := make(geo.Ring, len(coordinates))
				for j, c := range coordinates {
					ring[j] = geo.P(c[1], c[0])
				}

				if i == 0 {
					water = append(water, region.Item{ID: uint64(len(water) + 1), Polygon: geo.Polygon{Exterior: ring}})
				} else {
					islands = append(islands, region.Item{ID: uint64(len(islands) + 1), Polygon: geo.Polygon{Exterior: ring}})
				}
			}
		}
	}

	return water, islands, nil
}
