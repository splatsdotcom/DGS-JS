#include "mgs_gaussian.hpp"

#include <chrono>
#include <iostream>
#include <limits>

namespace mgs
{

static inline float float32_from_bits(uint32_t bits);
static inline uint32_t float32_to_bits(float f);
static inline uint16_t float32_to_float16(float f);
static inline uint32_t float32_pack_2x16(float f1, float f2);

//-------------------------------------------//

Gaussian::Gaussian(const vec3& _pos, const vec3& _scale, const quaternion& _orient, const std::array<vec4, MGS_NUM_SPHERICAL_HARMONIC>& _harmonics) :
	pos(_pos), scale(_scale), orient(_orient), harmonics(_harmonics)
{

}

GaussianPacked Gaussian::pack()
{
	mat4 M = qm::scale(scale) * quaternion_to_mat4(orient);
	float sigma[6] = {
		M[0][0] * M[0][0] + M[0][1] * M[0][1] + M[0][2] * M[0][2],
		M[0][0] * M[1][0] + M[0][1] * M[1][1] + M[0][2] * M[1][2],
		M[0][0] * M[2][0] + M[0][1] * M[2][1] + M[0][2] * M[2][2],
		M[1][0] * M[1][0] + M[1][1] * M[1][1] + M[1][2] * M[1][2],
		M[1][0] * M[2][0] + M[1][1] * M[2][1] + M[1][2] * M[2][2],
		M[2][0] * M[2][0] + M[2][1] * M[2][1] + M[2][2] * M[2][2]
	};

	GaussianPacked packed;
	packed.covariance[0] = float32_pack_2x16(4.0f * sigma[0], 4.0f * sigma[1]);
	packed.covariance[1] = float32_pack_2x16(4.0f * sigma[2], 4.0f * sigma[3]);
	packed.covariance[2] = float32_pack_2x16(4.0f * sigma[4], 4.0f * sigma[5]);
	packed.pos = pos;

	for(uint32_t i = 0; i < MGS_NUM_SPHERICAL_HARMONIC; i++)
	{
		uint8_t r = (uint8_t)std::min(std::max(harmonics[i].r * 255.0f, 0.0f), 255.0f);
		uint8_t g = (uint8_t)std::min(std::max(harmonics[i].g * 255.0f, 0.0f), 255.0f);
		uint8_t b = (uint8_t)std::min(std::max(harmonics[i].b * 255.0f, 0.0f), 255.0f);
		uint8_t a = (uint8_t)std::min(std::max(harmonics[i].a * 255.0f, 0.0f), 255.0f);

		packed.harmonics[i] = (a << 24) | (b << 16) | (g << 8) | r;
	}

	return packed;
}

Gaussian GaussianPacked::unpack()
{
	//TODO!
	return Gaussian(vec3(0.0f), vec3(0.01f), quaternion_identity(), {vec4(0.0f)});
}

GaussianGroup::GaussianGroup(const std::vector<GaussianPacked>& gaussians) :
	m_gaussians(gaussians)
{

}

uint32_t GaussianGroup::count() const
{
	return static_cast<uint32_t>(m_gaussians.size());
}

const std::vector<GaussianPacked>& GaussianGroup::data() const
{
	return m_gaussians;
}

std::vector<uint32_t> GaussianGroup::sorted_indices(const vec3& camPos)
{
	//precompute depths + min/max:
	//---------------
	std::vector<float> depths(count());

	float minDepth = std::numeric_limits<float>::infinity();
	float maxDepth = -std::numeric_limits<float>::infinity();
	for(uint32_t i = 0; i < count(); ++i)
	{
		depths[i] = dot(m_gaussians[i].pos - camPos, m_gaussians[i].pos - camPos);
		minDepth = std::min(minDepth, depths[i]);
		maxDepth = std::max(maxDepth, depths[i]);
	}

	//compute counts:
	//---------------
	const float scale = 65535.0f / (maxDepth - minDepth);
	std::vector<uint32_t> counts(65536, 0);

	for(uint32_t i = 0; i < count(); ++i) 
	{
		uint32_t idx = static_cast<uint32_t>((depths[i] - minDepth) * scale);
		++counts[idx >= UINT16_MAX ? UINT16_MAX - 1 : idx];
	}

	//prefix sum:
	//---------------
	uint32_t total = 0;
	for(uint32_t i = 0; i < 65536; ++i) 
	{
		uint32_t c = counts[i];
		counts[i] = total;
		total += c;
	}

	//output array:
	//---------------
	std::vector<uint32_t> sortedIndices(count());
	for(uint32_t i = 0; i < count(); ++i) 
	{
		uint32_t depthIdx = static_cast<uint32_t>((depths[i] - minDepth) * scale);
		uint32_t idx = counts[depthIdx]++;

		sortedIndices[idx] = i;
	}

	return sortedIndices;
}

//-------------------------------------------//

static inline float float32_from_bits(uint32_t bits)
{
	return *(float*)&bits;
}

static inline uint32_t float32_to_bits(float f)
{
	return *(uint32_t*)&f;
}

//from https://github.com/lifa08/float16_from_float32
static inline uint16_t float32_to_float16(float f)
{
#if defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 199901L) || defined(__GNUC__) && !defined(__STRICT_ANSI__)
	const float scaleToInf = 0x1.0p+112f;
	const float scaleToZero = 0x1.0p-110f;
#else
	const float scaleToInf = float32_from_bits(0x77800000U);
	const float scaleToZero = float32_from_bits(0x08800000U);
#endif
	float base = (fabsf(f) * scaleToInf) * scaleToZero;

	const uint32_t w = float32_to_bits(f);
	const uint32_t lshiftW = w + w;
	const uint32_t sign = w & 0x80000000U;
	uint32_t bias = lshiftW & 0xFF000000U;
	if(bias < 0x71000000U)
		bias = 0x71000000U;

	base = float32_from_bits((bias >> 1) + 0x07800000U) + base;
	const uint32_t bits = float32_to_bits(base);

	const uint32_t expBits = (bits >> 13) & 0x00007C00U;
	const uint32_t mantissaBits = bits & 0x00000FFFU;
	const uint32_t nonSign = expBits + mantissaBits;
	return (sign >> 16) | (lshiftW > 0xFF000000U ? 0x7E00 : nonSign);
}

static inline uint32_t float32_pack_2x16(float f1, float f2)
{
	return (float32_to_float16(f2) << 16U) | float32_to_float16(f1);
}

}; //namespace mgs