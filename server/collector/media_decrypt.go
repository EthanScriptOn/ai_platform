package main

import (
	"encoding/binary"
	"strconv"
)

const isaac64Golden uint64 = 0x9e3779b97f4a7c13

type isaac64State struct {
	count int
	mem   [256]uint64
	rsl   [256]uint64
	a     uint64
	b     uint64
	c     uint64
}

func mediaDecryptionArray(seed string, length int) []byte {
	if length <= 0 {
		return nil
	}
	var state isaac64State
	if value, err := strconv.ParseUint(seed, 10, 64); err == nil {
		state.rsl[0] = value
	}
	state.init(true)
	output := make([]byte, 0, length)
	var word [8]byte
	for len(output) < length {
		if state.count == 0 {
			state.generate()
			state.count = 256
		}
		state.count--
		binary.BigEndian.PutUint64(word[:], state.rsl[state.count])
		remaining := length - len(output)
		if remaining > len(word) {
			remaining = len(word)
		}
		output = append(output, word[:remaining]...)
	}
	return output
}

func decryptWechatMediaChunk(buffer []byte, key []byte, offset int64) {
	if len(buffer) == 0 || len(key) == 0 || offset >= int64(len(key)) {
		return
	}
	for index := range buffer {
		keyIndex := int(offset) + index
		if keyIndex >= len(key) {
			return
		}
		buffer[index] ^= key[keyIndex]
	}
}

func (s *isaac64State) init(useSeed bool) {
	a, b, c, d := isaac64Golden, isaac64Golden, isaac64Golden, isaac64Golden
	e, f, g, h := isaac64Golden, isaac64Golden, isaac64Golden, isaac64Golden
	for i := 0; i < 4; i++ {
		a, b, c, d, e, f, g, h = isaac64Mix(a, b, c, d, e, f, g, h)
	}
	for i := 0; i < 256; i += 8 {
		if useSeed {
			a += s.rsl[i]
			b += s.rsl[i+1]
			c += s.rsl[i+2]
			d += s.rsl[i+3]
			e += s.rsl[i+4]
			f += s.rsl[i+5]
			g += s.rsl[i+6]
			h += s.rsl[i+7]
		}
		a, b, c, d, e, f, g, h = isaac64Mix(a, b, c, d, e, f, g, h)
		s.mem[i] = a
		s.mem[i+1] = b
		s.mem[i+2] = c
		s.mem[i+3] = d
		s.mem[i+4] = e
		s.mem[i+5] = f
		s.mem[i+6] = g
		s.mem[i+7] = h
	}
	if useSeed {
		for i := 0; i < 256; i += 8 {
			a += s.mem[i]
			b += s.mem[i+1]
			c += s.mem[i+2]
			d += s.mem[i+3]
			e += s.mem[i+4]
			f += s.mem[i+5]
			g += s.mem[i+6]
			h += s.mem[i+7]
			a, b, c, d, e, f, g, h = isaac64Mix(a, b, c, d, e, f, g, h)
			s.mem[i] = a
			s.mem[i+1] = b
			s.mem[i+2] = c
			s.mem[i+3] = d
			s.mem[i+4] = e
			s.mem[i+5] = f
			s.mem[i+6] = g
			s.mem[i+7] = h
		}
	}
	s.generate()
	s.count = 256
}

func (s *isaac64State) generate() {
	s.c++
	s.b += s.c
	for i := 0; i < 256; i++ {
		x := s.mem[i]
		switch i & 3 {
		case 0:
			s.a = ^(s.a ^ (s.a << 21))
		case 1:
			s.a ^= s.a >> 5
		case 2:
			s.a ^= s.a << 12
		case 3:
			s.a ^= s.a >> 33
		}
		s.a += s.mem[(i+128)&255]
		y := s.mem[(x>>3)&255] + s.a + s.b
		s.mem[i] = y
		s.b = s.mem[(y>>11)&255] + x
		s.rsl[i] = s.b
	}
}

func isaac64Mix(a, b, c, d, e, f, g, h uint64) (uint64, uint64, uint64, uint64, uint64, uint64, uint64, uint64) {
	a -= e
	f ^= h >> 9
	h += a
	b -= f
	g ^= a << 9
	a += b
	c -= g
	h ^= b >> 23
	b += c
	d -= h
	a ^= c << 15
	c += d
	e -= a
	b ^= d >> 14
	d += e
	f -= b
	c ^= e << 20
	e += f
	g -= c
	d ^= f >> 17
	f += g
	h -= d
	e ^= g << 14
	g += h
	return a, b, c, d, e, f, g, h
}
