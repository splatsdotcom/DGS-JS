#include "mgs_gaussian.hpp"

#include <chrono>
#include <iostream>
#include <limits>
#include <algorithm>

namespace mgs
{

static inline float float32_from_bits(uint32_t bits);
static inline uint32_t float32_to_bits(float f);
static inline uint16_t float32_to_float16(float f);
static inline uint32_t float32_pack_2x16(float f1, float f2);

//-------------------------------------------//

Gaussian::Gaussian(const vec3& _pos, const vec3& _scale, const quaternion& _orient, const vec4& _color, const std::array<vec3, MGS_MAX_SH_COEFFS_REST>& _sh) :
	pos(_pos), scale(_scale), orient(_orient), color(_color), sh(_sh)
{

}

GaussianPacked Gaussian::pack() const
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
	packed.covariance1[0] = 4.0f * sigma[0];
	packed.covariance1[1] = 4.0f * sigma[1];
	packed.covariance1[2] = 4.0f * sigma[2];
	packed.covariance2[0] = 4.0f * sigma[3];
	packed.covariance2[1] = 4.0f * sigma[4];
	packed.covariance2[2] = 4.0f * sigma[5];
	packed.colorRG = float32_pack_2x16(color.r, color.g);
	packed.colorBA = float32_pack_2x16(color.b, color.a);
	packed.pos = pos;

	for(uint32_t i = 0; i < MGS_MAX_SH_COEFFS_REST; i += 2)
	{
		uint32_t idx1 = i + 0;
		uint32_t idx2 = i + 1;

		float f1 = sh[std::min(idx1 / 3, MGS_MAX_SH_COEFFS_REST - 1)].v[idx1 % 3];
		float f2 = sh[std::min(idx2 / 3, MGS_MAX_SH_COEFFS_REST - 1)].v[idx2 % 3];

		packed.sh[i / 2] = float32_pack_2x16(f1, f2);
	}

	return packed;
}

Gaussian GaussianPacked::unpack() const
{
	//TODO!
	return Gaussian(
		vec3(0.0f), 
		vec3(0.01f), 
		quaternion_identity(), 
		vec4(0.0f),
		std::array<vec3, MGS_MAX_SH_COEFFS_REST>()
	);
}

GaussianGroup::GaussianGroup(const std::vector<GaussianPacked>& gaussians, uint32_t shDegree) :
	m_gaussians(gaussians), m_shDegree(shDegree)
{

}

GaussianGroup::GaussianGroup(const std::vector<Gaussian>& gaussians, uint32_t shDegree) :
	m_shDegree(shDegree)
{
	m_gaussians.reserve(gaussians.size());
	for(uint32_t i = 0; i < gaussians.size(); i++)
		m_gaussians.push_back(gaussians[i].pack());
}

uint32_t GaussianGroup::get_num_gaussians() const
{
	return static_cast<uint32_t>(m_gaussians.size());
}

const std::vector<GaussianPacked>& GaussianGroup::get_gaussians() const
{
	return m_gaussians;
}

uint32_t GaussianGroup::get_sh_degree() const
{
	return m_shDegree;
}

std::vector<uint8_t> GaussianGroup::serialize() const
{
	//compute size of each gaussian:
	//-----------------	
	uint32_t numShCoeffs = 3 * ((m_shDegree + 1) * (m_shDegree + 1) - 1);
	uint64_t shCoeffsSize = sizeof(uint16_t) * numShCoeffs;
	uint64_t gaussianSize = sizeof(GaussianPacked) - (sizeof(GaussianPacked::sh) - shCoeffsSize);

	//compute total size, allocate mem:
	//-----------------	
	uint64_t totalSize = 0;
	totalSize += sizeof(uint32_t);                  //num gaussians
	totalSize += sizeof(uint32_t);                  //sh degree
	totalSize += m_gaussians.size() * gaussianSize; //gaussians

	std::vector<uint8_t> serialized;
	serialized.resize(totalSize);

	//write metadata:
	//-----------------	
	uint32_t numGaussians = get_num_gaussians();
	std::memcpy(
		serialized.data(), &numGaussians, sizeof(uint32_t)
	);
	std::memcpy(
		serialized.data() + sizeof(uint32_t), &m_shDegree, sizeof(uint32_t)
	);

	//write gaussians:
	//-----------------
	uint64_t offset = sizeof(uint32_t) + sizeof(uint32_t);
	
	for(uint32_t i = 0; i < numGaussians; i++)
	{
		std::memcpy(
			serialized.data() + offset, 
			&m_gaussians[i], gaussianSize
		);

		offset += gaussianSize;
	}

	return serialized;
}

void GaussianGroup::deserialize(const std::vector<uint8_t>& serialized)
{
	//read metadata:
	//-----------------	
	if(serialized.size() < sizeof(uint32_t) + sizeof(uint32_t))
		throw std::runtime_error("Serialized buffer is too small to contain metadata!");

	uint32_t numGaussians;
	std::memcpy(
		&numGaussians, serialized.data(), sizeof(uint32_t)
	);
	std::memcpy(
		&m_shDegree, serialized.data() + sizeof(uint32_t), sizeof(uint32_t)
	);

	if(m_shDegree > MGS_MAX_SH_DEGREE)
		throw std::runtime_error("Serialized buffer contained an invalid SH degree!");

	//compute size of each gaussian:
	//-----------------	
	uint32_t numShCoeffs = 3 * ((m_shDegree + 1) * (m_shDegree + 1) - 1);
	uint64_t shCoeffsSize = sizeof(uint16_t) * numShCoeffs;
	uint64_t gaussianSize = sizeof(GaussianPacked) - (sizeof(GaussianPacked::sh) - shCoeffsSize);

	//read gaussians:
	//-----------------
	uint64_t serializedGaussiansSize = serialized.size() - sizeof(uint32_t) - sizeof(uint32_t);
	if(serializedGaussiansSize != numGaussians * gaussianSize)
		throw std::runtime_error("Serialized buffer was incorrectly sized");

	m_gaussians.resize(numGaussians);

	uint64_t offset = sizeof(uint32_t) + sizeof(uint32_t);
	for(uint32_t i = 0; i < numGaussians; i++)
	{
		std::memcpy(
			&m_gaussians[i], 
			serialized.data() + offset,
			gaussianSize
		);

		offset += gaussianSize;
	}
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